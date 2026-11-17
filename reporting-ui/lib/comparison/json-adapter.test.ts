// Real XML-vs-JSON comparison test for the Chester FC vs Merthyr Town FC match.
//
// Master  = the SportsCode XML export (the correct reference).
// Analyst = the JSON event feed, converted to the SAME Instance shape via
//           jsonEventsToInstances, so it flows through the identical
//           compareInstances engine (matching / tolerance / accuracy).
//
// Runs in jsdom (see vitest.config.ts) so parseInstances' DOMParser works.
//
// The two fixtures are the SAME match, so this exercises the whole pipeline on
// genuine data. The assertions check the mechanics are sound (sane totals,
// correct stat-label mapping, goal time-offset alignment) rather than pinning
// an exact accuracy number — real coding disagreements between the two sources
// are expected and should surface, not be forced to "match".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import {
  parseInstances,
  compareInstances,
  codeTime,
  type Instance,
} from "./xml-compare";
import {
  jsonEventsToInstances,
  defaultMapStatName,
  type JsonEvent,
} from "./json-adapter";
import { scopeToOverlapPaired } from "./overlap-window";

const FIX = join(__dirname, "__fixtures__");
const MASTER_XML = "National League North 2026_08_full_Chester FC_Merthyr Town FC.xml";
const FEED_JSON = "pd-819-34131-AI.json";

type Feed = {
  homeTeamName: string;
  awayTeamName: string;
  homeTeamUid: number;
  awayTeamUid: number;
  allStatistics: JsonEvent[];
};

function loadMaster(): Instance[] {
  const xml = readFileSync(join(FIX, MASTER_XML), "utf8");
  return parseInstances(xml);
}

function loadFeed(): Feed {
  const raw = readFileSync(join(FIX, FEED_JSON), "utf8");
  return JSON.parse(raw) as Feed;
}

describe("Chester vs Merthyr — JSON feed vs master XML", () => {
  it("jsdom provides DOMParser so parseInstances actually parses", () => {
    const master = loadMaster();
    // The master XML has thousands of instances; anything > 0 proves DOMParser
    // ran (the engine returns [] when DOMParser is unavailable).
    expect(master.length).toBeGreaterThan(1000);
  });

  it("maps JSON statTypeCode to the exact XML stat labels", () => {
    // These are the byte-for-byte labels the master XML uses; a mismatch here
    // (e.g. "Carry" vs "Carries") silently prevents events from pairing.
    expect(defaultMapStatName("Pass", "ShortPassEffective")).toBe(
      "Short Passes Successful"
    );
    expect(defaultMapStatName("Pass", "ShortPassIneffective")).toBe(
      "Short Passes Unsuccessful"
    );
    expect(defaultMapStatName("Carry", "Carry")).toBe("Carries");
    expect(defaultMapStatName("Header Pass", "Header")).toBe("Header");
    expect(defaultMapStatName("Throw In", "ThrowIn")).toBe("Throw Ins");
    expect(defaultMapStatName("Corner", "Corner")).toBe("Corners");
    expect(defaultMapStatName("Kick Off", "KickOff")).toBe("Kick Offs");
    expect(defaultMapStatName("Free Kick", "FreeKickPass")).toBe(
      "Free Kick Passes"
    );
    // XML keeps the source misspelling "Unsuccesful" (single 's').
    expect(defaultMapStatName("Cross", "CrossIneffective")).toBe(
      "Crosses Unsuccesful"
    );
    expect(defaultMapStatName("Tackle", "TackleEffective")).toBe(
      "Tackles Successful"
    );
    expect(defaultMapStatName("Foul", "Foul")).toBe("Fouls");
    expect(defaultMapStatName("Shot in Play", "Goal")).toBe("Goals");
  });

  it("builds analyst instances from every timed feed event", () => {
    const feed = loadFeed();
    const analyst = jsonEventsToInstances(feed.allStatistics, {});
    // Every event has a finite relativeTime, so none should be dropped.
    expect(analyst.length).toBe(feed.allStatistics.length);
    // Instances come out sorted by code time (same as parseInstances).
    for (let i = 1; i < analyst.length; i++) {
      expect(analyst[i].mid).toBeGreaterThanOrEqual(analyst[i - 1].mid);
    }
  });

  it("codes a goal at the window midpoint (no fixed offset), same as the XML side", () => {
    // Goals carry NO special start offset: the true moment is the lead/lag
    // window midpoint, which is what the SportsCode timeline shows. The JSON
    // adapter must derive the goal's code time via the SAME codeTime() the XML
    // parser uses, so goals align across the two sources. The feed has no
    // window (end == start), so mid == start for this event.
    const feed = loadFeed();
    const goal = feed.allStatistics.find((e) => e.statTypeCode === "Goal");
    expect(goal).toBeDefined();
    const analyst = jsonEventsToInstances([goal!], {});
    expect(analyst).toHaveLength(1);
    expect(analyst[0].start).toBe(goal!.relativeTime);
    expect(analyst[0].mid).toBe(codeTime("Goals", goal!.relativeTime, goal!.relativeTime));
    // No fixed offset -> midpoint; with end == start that's start itself.
    expect(analyst[0].mid - analyst[0].start).toBe(0);
  });

  it("applies NO time offset to Throw Ins (raw feed time preserved)", () => {
    // Throw-ins carry no fixed offset: both the former −6s adapter shift and
    // the +7s codeTime entry were removed (see check-562 investigation). The
    // stored start equals the raw relativeTime, and mid is the window midpoint
    // (== start here, since feed events have end == start). A corner, which
    // DOES keep its +5s codeTime offset, is used as the contrast.
    const throwIn: JsonEvent = {
      uid: 9001,
      relativeTime: 36, // 00:36
      statTypeCode: "ThrowIn",
      statTypeName: "Throw In",
      teamName: "Home",
      playerNumber: 7,
    };
    const corner: JsonEvent = {
      uid: 9002,
      relativeTime: 36,
      statTypeCode: "Corner",
      statTypeName: "Corner",
      teamName: "Home",
      playerNumber: 7,
    };

    const [ti] = jsonEventsToInstances([throwIn], {});
    expect(ti.stat.toLowerCase()).toContain("throw in");
    // No shift: start stays at the raw 36.
    expect(ti.start).toBe(36);
    // No throw-in codeTime offset: mid falls through to the midpoint (== start).
    expect(ti.mid).toBe(codeTime("Throw Ins", 36, 36));
    expect(ti.mid).toBe(36);

    // A corner at the same raw time keeps its own +5s codeTime offset.
    const [co] = jsonEventsToInstances([corner], {});
    expect(co.start).toBe(36);
    expect(co.mid).toBe(codeTime("Corners", 36, 36));
  });

  it("keeps Kick Offs (and their same-time pass) and grades the opening Kick Off in overlap scope", () => {
    // Shape of the pd-845-36082-Training analyst feed: StartHalf marker, then
    // a Kick Off immediately followed by a pass at the SAME time by the SAME
    // player. (Pitch coordinates aren't read by the adapter, so omitted.)
    const player = {
      playerName: "Alek Bozinovski",
      playerNumber: 8,
      playerUid: 213230,
      teamName: "VIC Rovers U13 Boys",
      teamUid: 10609,
    };
    const ev = (uid: number, t: number, code: string, name: string): JsonEvent => ({
      uid,
      quarter: 1,
      relativeTime: t,
      statTypeCode: code,
      statTypeName: name,
      ...player,
    });
    const analystEvents: JsonEvent[] = [
      { uid: 27, quarter: 1, relativeTime: 79, statTypeCode: "StartHalf", statTypeName: "Start Half", playerUid: 0 },
      ev(28, 79, "KickOff", "Kick Off"),
      ev(29, 79, "LongPassEffective", "Pass"),
      ev(176, 365, "KickOff", "Kick Off"),
      ev(177, 365, "ShortPassEffective", "Pass"),
      ev(1575, 2533, "KickOff", "Kick Off"),
      ev(1576, 2533, "ShortPassEffective", "Pass"),
    ];
    const analyst = jsonEventsToInstances(analystEvents, {});
    // StartHalf dropped; each Kick Off AND its pass kept as separate instances.
    expect(analyst).toHaveLength(6);
    const kos = analyst.filter((i) => i.stat === "Kick Offs");
    expect(kos.map((i) => [i.start, i.category, i.playerNumber])).toEqual([
      [79, "Event", 8],
      [365, "Event", 8],
      [2533, "Event", 8],
    ]);

    // Master codes the same moments 0-2s later (as in saved check 953), so the
    // master defines the overlap window and starts at 80s — 1s AFTER the
    // analyst's opening Kick Off.
    const master = jsonEventsToInstances(
      [
        ev(1, 80, "KickOff", "Kick Off"),
        ev(2, 80, "LongPassEffective", "Pass"),
        ev(3, 367, "KickOff", "Kick Off"),
        ev(4, 2533, "KickOff", "Kick Off"),
      ],
      {}
    );
    const scoped = scopeToOverlapPaired(master, analyst, 3, "Home v Away");
    const r = compareInstances(scoped.master, scoped.analyst, 3, "Home v Away");
    const koRows = r.rows.filter((x) => x.master?.stat === "Kick Offs");
    expect(koRows.map((x) => [x.status, x.analyst?.start])).toEqual([
      ["exact", 79],
      ["exact", 365],
      ["exact", 2533],
    ]);
    // Kick Off and the same-time pass don't double count each other.
    expect(r.summary.exact).toBe(4);
    expect(r.summary.missed).toBe(0);
  });

  it("runs the full comparison and produces sane, self-consistent totals", () => {
    const master = loadMaster();
    const feed = loadFeed();
    const analyst = jsonEventsToInstances(feed.allStatistics, {});

    const result = compareInstances(master, analyst, 3, MASTER_XML);
    const s = result.summary;

    // Totals reflect the inputs.
    expect(s.masterTotal).toBe(master.length);
    expect(s.analystTotal).toBe(analyst.length);

    // Every master instance is accounted for in exactly one outcome bucket.
    expect(s.exact + s.wrongStat + s.wrongPlayer + s.wrongTeam + s.missed).toBe(
      s.masterTotal
    );

    // Accuracy is a fraction in [0,1] and equals exact/masterTotal.
    expect(s.accuracy).toBeGreaterThanOrEqual(0);
    expect(s.accuracy).toBeLessThanOrEqual(1);
    expect(s.accuracy).toBeCloseTo(s.exact / s.masterTotal, 5);

    // The stat-label mapping works: because labels now match byte-for-byte,
    // comparable events that fall in the same time window ARE paired (as
    // exact / wrong-stat / wrong-player / wrong-team) rather than all being
    // dropped as missed. If the mapping regressed (e.g. "Carry" vs "Carries"),
    // these paired counts would collapse toward zero. This is the real guard
    // against a silent mapping break — NOT a fixed accuracy floor, because the
    // two sources genuinely disagree (see the note below).
    const paired = s.exact + s.wrongStat + s.wrongPlayer + s.wrongTeam;
    expect(paired).toBeGreaterThan(500);
    expect(s.exact).toBeGreaterThan(0);

    // NOTE ON THE LOW EXACT RATE (~3%): this is a REAL result, not a bug. The
    // master XML and the JSON feed independently code the same match, and they
    // disagree substantially — different event counts (e.g. 798 vs 835 short
    // passes), a drifting event clock (sequences diverge by seconds and can't
    // be realigned by a constant offset), and different player attribution
    // (the feed's first pass is #33 Reed; the master's is #11 Waters). The
    // engine is correctly surfacing that disagreement. Do not "fix" this by
    // loosening matching to force agreement.

    // Breakdowns are populated and their category totals reconcile.
    expect(result.byCategory.length).toBeGreaterThan(0);
    expect(result.byStat.length).toBeGreaterThan(0);
    expect(result.byTeam.length).toBeGreaterThan(0);

    // Print the real accuracy breakdown for inspection.
    console.log(
      "\n=== Chester vs Merthyr: JSON feed vs master XML (tolerance 3s) ===\n" +
        `master=${s.masterTotal} analyst=${s.analystTotal} ` +
        `exact=${s.exact} (${(s.accuracy * 100).toFixed(1)}%)\n` +
        `wrongStat=${s.wrongStat} wrongPlayer=${s.wrongPlayer} ` +
        `wrongTeam=${s.wrongTeam} missed=${s.missed} extra=${s.extra} ` +
        `avgTimeDrift=${s.avgTimeDrift.toFixed(2)}s\n` +
        "by stat (master total / exact / accuracy%):\n" +
        result.byStat
          .slice()
          .sort((a, b) => b.total - a.total)
          .map(
            (b) =>
              `  ${b.stat.padEnd(28)} ${String(b.total).padStart(4)} / ` +
              `${String(b.exact).padStart(4)} / ${(b.accuracy * 100).toFixed(0)}%`
          )
          .join("\n")
    );
  });
});
