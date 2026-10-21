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

  // NAME-ONLY per the user directive: the comparison stat is the feed's
  // `statTypeName`, used as-is. The statTypeCode is IGNORED for matching — on
  // this platform it is a coarse bucket (code "Save" covers Claimed / Keeper
  // Throw Successful / Goal Kick Successful / Save; code "ShotOffTarget" covers
  // "Shot Off Target" and "Shot Blocked"), so the NAME is the real action.
  it("uses the feed statTypeName as the stat, ignoring the code", () => {
    expect(defaultMapStatName("Shot Off Target", "ShotOffTarget")).toBe(
      "Shot Off Target"
    );
    // Same code, different name -> the NAME wins (code is coarse).
    expect(defaultMapStatName("Shot Blocked", "ShotOffTarget")).toBe(
      "Shot Blocked"
    );
    expect(defaultMapStatName("Claimed", "Save")).toBe("Claimed");
    expect(defaultMapStatName("Keeper Throw Successful", "Save")).toBe(
      "Keeper Throw Successful"
    );
    expect(defaultMapStatName("Goal Kick Successful", "Save")).toBe(
      "Goal Kick Successful"
    );
    expect(defaultMapStatName("Save", "Save")).toBe("Save");
    expect(defaultMapStatName("Goal", "Goal")).toBe("Goal");
    // Trimmed.
    expect(defaultMapStatName("  Header  ", "Header")).toBe("Header");
  });

  it("falls back to the de-camel-cased code only when the name is empty", () => {
    expect(defaultMapStatName("", "ShortPassEffective")).toBe(
      "Short Pass Effective"
    );
    expect(defaultMapStatName("   ", "SomeNewCode")).toBe("Some New Code");
    // Name present -> name wins even if a code is given.
    expect(defaultMapStatName("Shot Off Target", "")).toBe("Shot Off Target");
    expect(defaultMapStatName("Shot Off Target")).toBe("Shot Off Target");
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

    // RE-BASELINED per the user directive (stat = the feed's `statTypeName`).
    // The JSON stat label is now the feed NAME, e.g. "Pass", "Shot Off Target",
    // "Keeper Throw Successful" — the feed's own vocabulary, which the
    // SportsCode master XML mostly does NOT share (the XML carries
    // "Short Passes Successful", "Shots Off Target", etc.). So against an XML
    // master only the handful of names that coincide verbatim with an XML label
    // (e.g. "Header") can score exact; the rest pair as wrong_stat or fall out.
    // This is EXPECTED: name-matching is for JSON-vs-JSON (same platform, same
    // names on both sides), proven by the dedicated JSON-vs-JSON pairing test
    // below. This legacy XML-vs-JSON fixture only guards that pairing doesn't
    // TOTALLY collapse — it does not assert a meaningful exact rate across the
    // two different label vocabularies.
    const paired = s.exact + s.wrongStat + s.wrongPlayer + s.wrongTeam;
    expect(paired).toBeGreaterThan(100);
    expect(s.exact).toBeGreaterThanOrEqual(0); // cross-vocabulary: near-zero

    // NOTE: this is a REAL result, not a bug. The master XML and the JSON feed
    // independently code the same match and disagree substantially — different
    // event counts, a drifting event clock, and different player attribution.
    // On top of that, name-matching (per the user directive) uses the feed's
    // own vocabulary, which the XML master does not share. The engine is
    // correctly surfacing that. Do not "fix" this by loosening matching.

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
// Name-only stat mapping (the user's directive: the comparison timeline/stat
// matches on the feed's `statTypeName`; the coarse `statTypeCode` is ignored).
// ---------------------------------------------------------------------------
describe("JSON adapter — name-only stat mapping", () => {
  it("sets Instance.stat to the feed statTypeName, ignoring the code", () => {
    const events: JsonEvent[] = [
      {
        uid: 1,
        relativeTime: 100,
        statTypeCode: "ShotOffTarget",
        statTypeName: "Shot Off Target",
        teamName: "Home",
        playerNumber: 9,
      },
      {
        uid: 2,
        relativeTime: 110,
        statTypeCode: "Goal",
        statTypeName: "Goal",
        teamName: "Home",
        playerNumber: 9,
      },
      {
        uid: 3,
        relativeTime: 120,
        statTypeCode: "Save",
        statTypeName: "Keeper Throw Successful",
        teamName: "Away",
        playerNumber: 1,
      },
    ];
    const insts = jsonEventsToInstances(events, {});
    const byId = new Map(insts.map((i) => [i.id, i]));
    expect(byId.get("1")!.stat).toBe("Shot Off Target");
    expect(byId.get("2")!.stat).toBe("Goal");
    expect(byId.get("3")!.stat).toBe("Keeper Throw Successful");
  });

  it("same code, different name -> DISTINCT stats (name is the real action)", () => {
    // Code "Save" is a coarse bucket; the NAME distinguishes the actions, so
    // a "Claimed" and a "Goal Kick Successful" (both code "Save") stay distinct.
    const insts = jsonEventsToInstances(
      [
        {
          uid: 10,
          relativeTime: 50,
          statTypeCode: "Save",
          statTypeName: "Claimed",
          teamName: "Home",
          playerNumber: 1,
        },
        {
          uid: 11,
          relativeTime: 60,
          statTypeCode: "Save",
          statTypeName: "Goal Kick Successful",
          teamName: "Home",
          playerNumber: 1,
        },
      ],
      {}
    );
    expect(insts.map((i) => i.stat)).toEqual([
      "Claimed",
      "Goal Kick Successful",
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

  it("still resolves the category for name-based stats", () => {
    // Category uses the code via STAT_CODE_MAP when present (real feeds carry
    // both), so name-keying the stat does not disturb grouping.
    expect(defaultMapCategory("ShotOffTarget", "Shot Off Target")).toBe("Shots");
    expect(defaultMapCategory("Goal", "Goal")).toBe("Shots");
    expect(defaultMapCategory("Save", "Keeper Throw Successful")).toBe("Goal Keeper");
    expect(defaultMapCategory("Header", "Header")).toBe("General Play");
    expect(defaultMapCategory("ShortPassEffective", "Pass")).toBe("Passing");

    // Name-only fallback (no code) classifies by keyword in the label itself.
    expect(defaultMapCategory(undefined, "Shot Off Target")).toBe("Shots");
    expect(defaultMapCategory(undefined, "Keeper Throw Successful")).toBe("Goal Keeper");
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
    // Only the real action (Carry) survives; its stat is the name "Carry".
    expect(insts.map((i) => i.stat)).toEqual(["Carry"]);
  });

  it("pairs two name-matched JSON feeds as EXACT (JSON-vs-JSON, same platform)", () => {
    // Master and analyst are two JSON feeds from the same platform. They match
    // on the stat type NAME: same name at the same player/team/time => exact,
    // regardless of the coarse code (here both use the bucket code "Save").
    const mk = (uid: number, name: string, t: number): JsonEvent => ({
      uid,
      relativeTime: t,
      statTypeCode: "Save",
      statTypeName: name,
      teamName: "Chester FC",
      playerNumber: 9,
    });
    const master = jsonEventsToInstances(
      [mk(1, "Claimed", 100), mk(2, "Goal Kick Successful", 200)],
      {}
    );
    const analyst = jsonEventsToInstances(
      [mk(101, "Claimed", 100), mk(102, "Goal Kick Successful", 200)],
      {}
    );
    const result = compareInstances(master, analyst, 3, "feed.json");
    expect(result.summary.masterTotal).toBe(2);
    expect(result.summary.exact).toBe(2);
    expect(result.summary.accuracy).toBe(1);
  });

  it("round-trips a name-based stat through the native export", () => {
    // The stat is the feed name "Shot Off Target". If it is not a
    // CANONICAL_TO_NATIVE key it exports with an empty statTypeCode and the
    // name as statTypeName; name-only import reads it straight back.
    const original = jsonEventsToInstances(
      [
        {
          uid: 40,
          relativeTime: 300,
          statTypeCode: "ShotOffTarget",
          statTypeName: "Shot Off Target",
          teamName: "Chester FC",
          playerNumber: 9,
        },
      ],
      {}
    );
    expect(original[0].stat).toBe("Shot Off Target");

    const json = serializeInstancesToJson(original);
    const reimported = jsonEventsToInstances(
      (JSON.parse(json) as { allStatistics: JsonEvent[] }).allStatistics,
      {}
    );
    expect(reimported[0].stat).toBe("Shot Off Target");
  });
});
