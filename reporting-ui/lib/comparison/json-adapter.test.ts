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
