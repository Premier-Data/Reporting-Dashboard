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
  defaultMapCategory,
  serializeInstancesToJson,
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

  // COMBINED per the user directive: the comparison stat references BOTH feed
  // fields as "<statTypeName> - <de-camel(statTypeCode)>". So the fine-grained
  // code stays visible alongside the coarse name — a saved shot and an
  // off-target shot (both name "Shot in Play") read distinctly as
  // "Shot in Play - Shot Saved" vs "Shot in Play - Shot Off Target".
  it("combines statTypeName and de-camel(statTypeCode) as '<name> - <code>'", () => {
    expect(defaultMapStatName("Shot in Play", "ShotSaved")).toBe(
      "Shot in Play - Shot Saved"
    );
    expect(defaultMapStatName("Shot in Play", "ShotOffTarget")).toBe(
      "Shot in Play - Shot Off Target"
    );
    expect(defaultMapStatName("Shot in Play", "Goal")).toBe(
      "Shot in Play - Goal"
    );
    expect(defaultMapStatName("Header Shot", "ShotOffTarget")).toBe(
      "Header Shot - Shot Off Target"
    );
    expect(defaultMapStatName("Pass", "ShortPassEffective")).toBe(
      "Pass - Short Pass Effective"
    );
    expect(defaultMapStatName("Keeper", "Save")).toBe("Keeper - Save");
    // Trimmed on both sides.
    expect(defaultMapStatName("  Keeper  ", "Save")).toBe("Keeper - Save");
  });

  it("uses whichever field is present when one is missing", () => {
    // No code -> name as-is.
    expect(defaultMapStatName("Shot in Play", "")).toBe("Shot in Play");
    expect(defaultMapStatName("Shot in Play")).toBe("Shot in Play");
    // No name -> de-camel-cased code only.
    expect(defaultMapStatName("", "ShortPassEffective")).toBe(
      "Short Pass Effective"
    );
    expect(defaultMapStatName("   ", "SomeNewCode")).toBe("Some New Code");
    // Neither present -> empty string.
    expect(defaultMapStatName("", "")).toBe("");
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

    // RE-BASELINED per the user directive (stat = "<statTypeName> - <code>").
    // The JSON stat label is now the COMBINED feed label, e.g.
    // "Pass - Short Pass Effective" / "Shot in Play - Shot Saved", which the
    // SportsCode master XML never uses — the XML carries its own labels
    // ("Short Passes Successful", "Shots Off Target"). So against an XML master
    // the combined-label feed pairs on even FEWER stats than the earlier
    // name-only mapping, and NOTHING matches as `exact` (no XML label equals a
    // "<name> - <code>" string). This is EXPECTED: the combined label is for
    // JSON-vs-JSON (same platform, identical name+code on both sides), proven
    // by the dedicated JSON-vs-JSON pairing test below. This legacy XML-vs-JSON
    // fixture only guards that pairing doesn't TOTALLY collapse (same-time
    // events still pair as wrong_stat) — it no longer asserts any exact
    // matches, which are impossible across the two label vocabularies.
    const paired = s.exact + s.wrongStat + s.wrongPlayer + s.wrongTeam;
    expect(paired).toBeGreaterThan(100);
    expect(s.exact).toBe(0); // no XML label equals a combined "<name> - <code>"

    // NOTE: this is a REAL result, not a bug. The master XML and the JSON feed
    // independently code the same match and disagree substantially — different
    // event counts, a drifting event clock, and different player attribution.
    // On top of that, the combined-label mapping (per the user directive) uses
    // the feed's own vocabulary, which the XML master does not share. The
    // engine is correctly surfacing that. Do not "fix" this by loosening
    // matching.

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

// ---------------------------------------------------------------------------
// Combined stat mapping (the user's directive: the comparison timeline/stat
// references BOTH feed fields as "<statTypeName> - <de-camel(statTypeCode)>").
// ---------------------------------------------------------------------------
describe("JSON adapter — combined name+code stat mapping", () => {
  it("sets Instance.stat to '<name> - <code>', keeping the code distinction", () => {
    const events: JsonEvent[] = [
      {
        uid: 1,
        relativeTime: 100,
        statTypeCode: "ShotOffTarget",
        statTypeName: "Header Shot",
        teamName: "Home",
        playerNumber: 9,
      },
      {
        uid: 2,
        relativeTime: 110,
        statTypeCode: "Goal",
        statTypeName: "Shot in Play",
        teamName: "Home",
        playerNumber: 9,
      },
      {
        uid: 3,
        relativeTime: 120,
        statTypeCode: "Save",
        statTypeName: "Keeper",
        teamName: "Away",
        playerNumber: 1,
      },
    ];
    const insts = jsonEventsToInstances(events, {});
    const byId = new Map(insts.map((i) => [i.id, i]));
    expect(byId.get("1")!.stat).toBe("Header Shot - Shot Off Target");
    expect(byId.get("2")!.stat).toBe("Shot in Play - Goal");
    expect(byId.get("3")!.stat).toBe("Keeper - Save");
  });

  it("same name, different code -> DISTINCT stats (code disambiguates)", () => {
    // Both carry name "Shot in Play" but different codes, so the combined label
    // keeps them distinct — a saved shot is NOT the same stat as a goal.
    const insts = jsonEventsToInstances(
      [
        {
          uid: 10,
          relativeTime: 50,
          statTypeCode: "ShotSaved",
          statTypeName: "Shot in Play",
          teamName: "Home",
          playerNumber: 9,
        },
        {
          uid: 11,
          relativeTime: 60,
          statTypeCode: "Goal",
          statTypeName: "Shot in Play",
          teamName: "Home",
          playerNumber: 9,
        },
      ],
      {}
    );
    expect(insts.map((i) => i.stat)).toEqual([
      "Shot in Play - Shot Saved",
      "Shot in Play - Goal",
    ]);
  });

  it("falls back to the de-camel-cased code when statTypeName is empty", () => {
    const [inst] = jsonEventsToInstances(
      [
        {
          uid: 20,
          relativeTime: 70,
          statTypeCode: "ShortPassEffective",
          statTypeName: "",
          teamName: "Home",
          playerNumber: 8,
        },
      ],
      {}
    );
    expect(inst.stat).toBe("Short Pass Effective");
  });

  it("still resolves the category for combined-label stats", () => {
    // Category uses the code via STAT_CODE_MAP when present (real feeds carry
    // both), so the combined stat label does not disturb grouping.
    expect(defaultMapCategory("ShotOffTarget", "Header Shot - Shot Off Target")).toBe("Shots");
    expect(defaultMapCategory("Goal", "Shot in Play - Goal")).toBe("Shots");
    expect(defaultMapCategory("Save", "Keeper - Save")).toBe("Goal Keeper");
    expect(defaultMapCategory("Header", "Header Pass - Header")).toBe("General Play");
    expect(defaultMapCategory("ShortPassEffective", "Pass - Short Pass Effective")).toBe("Passing");

    // Name-only fallback (no code) classifies by keyword in the label itself.
    expect(defaultMapCategory(undefined, "Header Shot")).toBe("Shots");
    expect(defaultMapCategory(undefined, "Shot in Play")).toBe("Shots");
    expect(defaultMapCategory(undefined, "Keeper")).toBe("Goal Keeper");
    expect(defaultMapCategory(undefined, "Pass")).toBe("Passing");
  });

  it("excludes non-action markers by BOTH code and name", () => {
    const insts = jsonEventsToInstances(
      [
        {
          uid: 30,
          relativeTime: 0,
          statTypeCode: "StartHalf",
          statTypeName: "Start Half",
          teamName: "Home",
        },
        {
          uid: 31,
          relativeTime: 5,
          statTypeCode: "",
          statTypeName: "Substitution",
          teamName: "Home",
        },
        {
          uid: 32,
          relativeTime: 10,
          statTypeCode: "Carry",
          statTypeName: "Carry",
          teamName: "Home",
          playerNumber: 7,
        },
      ],
      {}
    );
    // Only the real action (Carry) survives; its combined label is "Carry - Carry".
    expect(insts.map((i) => i.stat)).toEqual(["Carry - Carry"]);
  });

  it("pairs two name+code-matched JSON feeds as EXACT (JSON-vs-JSON, same platform)", () => {
    // Master and analyst are two JSON feeds from the same platform: identical
    // name+code at the same player/team/time. The combined label makes them
    // pair EXACTly.
    const mk = (uid: number, name: string, code: string, t: number): JsonEvent => ({
      uid,
      relativeTime: t,
      statTypeCode: code,
      statTypeName: name,
      teamName: "Chester FC",
      playerNumber: 9,
    });
    const master = jsonEventsToInstances(
      [
        mk(1, "Shot in Play", "ShotSaved", 100),
        mk(2, "Shot in Play", "Goal", 200),
      ],
      {}
    );
    const analyst = jsonEventsToInstances(
      [
        mk(101, "Shot in Play", "ShotSaved", 100),
        mk(102, "Shot in Play", "Goal", 200),
      ],
      {}
    );
    const result = compareInstances(master, analyst, 3, "feed.json");
    expect(result.summary.masterTotal).toBe(2);
    expect(result.summary.exact).toBe(2);
    expect(result.summary.accuracy).toBe(1);
  });

  it("round-trips a combined-label stat through the native export", () => {
    // The combined label "Header Shot - Shot Off Target" is not a
    // CANONICAL_TO_NATIVE key, so it exports with an empty statTypeCode and the
    // whole combined label as statTypeName; on re-import the name is non-empty
    // (and there is no code to append), so it reads straight back unchanged.
    const original = jsonEventsToInstances(
      [
        {
          uid: 40,
          relativeTime: 300,
          statTypeCode: "ShotOffTarget",
          statTypeName: "Header Shot",
          teamName: "Chester FC",
          playerNumber: 9,
        },
      ],
      {}
    );
    expect(original[0].stat).toBe("Header Shot - Shot Off Target");

    const json = serializeInstancesToJson(original);
    const reimported = jsonEventsToInstances(
      (JSON.parse(json) as { allStatistics: JsonEvent[] }).allStatistics,
      {}
    );
    expect(reimported[0].stat).toBe("Header Shot - Shot Off Target");
  });
});
