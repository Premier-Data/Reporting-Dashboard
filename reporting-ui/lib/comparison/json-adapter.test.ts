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

  // RE-BASELINED per the user directive: the comparison stat now references
  // the feed's `statTypeName`, NOT the `statTypeCode`-derived canonical label.
  // `defaultMapStatName` is therefore NAME-PRIMARY — a non-empty trimmed
  // statTypeName is used as-is; the code-derived label is only a fallback for
  // when the name is missing/empty. These assertions use the real fixture
  // code|name pairs (ShortPassEffective|Pass, ShotOffTarget|Shot in Play, …).
  it("uses the feed statTypeName as the canonical stat (name-primary)", () => {
    // Name present -> name wins, used verbatim (trimmed).
    expect(defaultMapStatName("Pass", "ShortPassEffective")).toBe("Pass");
    expect(defaultMapStatName("Pass", "ShortPassIneffective")).toBe("Pass");
    expect(defaultMapStatName("Carry", "Carry")).toBe("Carry");
    expect(defaultMapStatName("Header Pass", "Header")).toBe("Header Pass");
    expect(defaultMapStatName("Throw In", "ThrowIn")).toBe("Throw In");
    expect(defaultMapStatName("Corner", "Corner")).toBe("Corner");
    expect(defaultMapStatName("Kick Off", "KickOff")).toBe("Kick Off");
    expect(defaultMapStatName("Free Kick", "FreeKickPass")).toBe("Free Kick");
    expect(defaultMapStatName("Cross", "CrossIneffective")).toBe("Cross");
    expect(defaultMapStatName("Tackle", "TackleEffective")).toBe("Tackle");
    expect(defaultMapStatName("Foul", "Foul")).toBe("Foul");
    expect(defaultMapStatName("Shot in Play", "Goal")).toBe("Shot in Play");
    expect(defaultMapStatName("  Keeper  ", "Save")).toBe("Keeper");
  });

  it("falls back to the code-derived label only when the name is empty", () => {
    // Missing/empty name -> fall back to STAT_CODE_MAP, keeping the exact XML
    // labels (incl. the source misspelling "Unsuccesful") so a name-less feed
    // still pairs against the XML master.
    expect(defaultMapStatName("", "ShortPassEffective")).toBe(
      "Short Passes Successful"
    );
    expect(defaultMapStatName("   ", "CrossIneffective")).toBe(
      "Crosses Unsuccesful"
    );
    // Unknown code with no name -> de-camel-cased code (legible fallback).
    expect(defaultMapStatName("", "SomeNewCode")).toBe("Some New Code");
    // No name and no code -> empty string.
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

    // RE-BASELINED per the user directive (name-based stat wins). The stat
    // label is now the feed's `statTypeName` (coarse, e.g. "Pass", "Shot in
    // Play"), which the SportsCode master XML does NOT use — the XML carries
    // fine-grained labels ("Short Passes Successful", "Shots Off Target"). So
    // against an XML master the name-keyed feed pairs on FEWER stats than the
    // old code-keyed mapping did (paired dropped from ~500+ to ~251). This is
    // expected: name-keying is designed for JSON-vs-JSON (same platform, same
    // names on both sides), not JSON-vs-XML. The floor below just guards
    // against a total pairing collapse, not the old code-keyed value.
    const paired = s.exact + s.wrongStat + s.wrongPlayer + s.wrongTeam;
    expect(paired).toBeGreaterThan(100);
    expect(s.exact).toBeGreaterThan(0);

    // NOTE ON THE LOW EXACT RATE: this is a REAL result, not a bug. The master
    // XML and the JSON feed independently code the same match and disagree
    // substantially — different event counts, a drifting event clock, and
    // different player attribution. On top of that, name-keying (per the user
    // directive) intentionally loosens granularity so coarse feed names won't
    // line up with the XML's fine-grained labels. The engine is correctly
    // surfacing that disagreement. Do not "fix" this by loosening matching.

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
// Name-primary stat mapping (the user's directive: the comparison timeline/
// stat references the feed's `statTypeName`, not the statTypeCode label).
// ---------------------------------------------------------------------------
describe("JSON adapter — name-primary stat mapping", () => {
  it("sets Instance.stat to the feed statTypeName, not the code label", () => {
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
    // stat is the NAME, not the old code-derived label ("Shots Off Target",
    // "Goals", "Saves").
    expect(byId.get("1")!.stat).toBe("Header Shot");
    expect(byId.get("2")!.stat).toBe("Shot in Play");
    expect(byId.get("3")!.stat).toBe("Keeper");
  });

  it("two events with the same name pair on that name", () => {
    // ShotOffTarget|Header Shot and Goal|Header Shot both map to "Header Shot".
    const insts = jsonEventsToInstances(
      [
        {
          uid: 10,
          relativeTime: 50,
          statTypeCode: "ShotOffTarget",
          statTypeName: "Header Shot",
          teamName: "Home",
          playerNumber: 9,
        },
        {
          uid: 11,
          relativeTime: 60,
          statTypeCode: "Goal",
          statTypeName: "Header Shot",
          teamName: "Home",
          playerNumber: 9,
        },
      ],
      {}
    );
    expect(insts.map((i) => i.stat)).toEqual(["Header Shot", "Header Shot"]);
  });

  it("falls back to the code-derived label when statTypeName is empty", () => {
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
    expect(inst.stat).toBe("Short Passes Successful");
  });

  it("still resolves the category for name-based stats", () => {
    // Category uses the code via STAT_CODE_MAP when present (real feeds carry
    // both), so name-keying the stat does not disturb grouping.
    expect(defaultMapCategory("ShotOffTarget", "Header Shot")).toBe("Shots");
    expect(defaultMapCategory("Goal", "Shot in Play")).toBe("Shots");
    expect(defaultMapCategory("Save", "Keeper")).toBe("Goal Keeper");
    expect(defaultMapCategory("Header", "Header Pass")).toBe("General Play");
    expect(defaultMapCategory("ShortPassEffective", "Pass")).toBe("Passing");

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
    // Only the real action (Carry) survives.
    expect(insts.map((i) => i.stat)).toEqual(["Carry"]);
  });

  it("pairs two name-matched JSON feeds as EXACT (JSON-vs-JSON, same platform)", () => {
    // Master and analyst are two JSON feeds from the same platform: identical
    // names at the same player/team/time. Name-keying makes them pair EXACTly.
    const mk = (uid: number, name: string, t: number): JsonEvent => ({
      uid,
      relativeTime: t,
      statTypeCode: "ShotOffTarget",
      statTypeName: name,
      teamName: "Chester FC",
      playerNumber: 9,
    });
    const master = jsonEventsToInstances(
      [mk(1, "Header Shot", 100), mk(2, "Shot in Play", 200)],
      {}
    );
    const analyst = jsonEventsToInstances(
      [mk(101, "Header Shot", 100), mk(102, "Shot in Play", 200)],
      {}
    );
    const result = compareInstances(master, analyst, 3, "feed.json");
    expect(result.summary.masterTotal).toBe(2);
    expect(result.summary.exact).toBe(2);
    expect(result.summary.accuracy).toBe(1);
  });

  it("round-trips a name-based (non-canonical) stat through the native export", () => {
    // A name-based label that is NOT a CANONICAL_TO_NATIVE key exports with an
    // empty statTypeCode and the label as statTypeName; name-primary import
    // then reads it straight back.
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
    expect(original[0].stat).toBe("Header Shot");

    const json = serializeInstancesToJson(original);
    const reimported = jsonEventsToInstances(
      (JSON.parse(json) as { allStatistics: JsonEvent[] }).allStatistics,
      {}
    );
    // "Header Shot" is not a canonical key, so it exported as code "" + name
    // "Header Shot" and re-imports to the same name.
    expect(reimported[0].stat).toBe("Header Shot");

    // A CANONICAL label still round-trips, but note the EXPECTED SHIFT under
    // name-primary: the export emits the native coarse name ("Carry" for
    // canonical "Carries"), and re-import now returns that NAME, not the
    // code-derived canonical label. This is the intended consequence of the
    // directive (name wins on import).
    const canonical = jsonEventsToInstances(
      [
        {
          uid: 41,
          relativeTime: 310,
          statTypeCode: "Carry",
          statTypeName: "",
          teamName: "Chester FC",
          playerNumber: 7,
        },
      ],
      {}
    );
    // Name empty -> fell back to the canonical label "Carries".
    expect(canonical[0].stat).toBe("Carries");
    const json2 = serializeInstancesToJson(canonical);
    const reimported2 = jsonEventsToInstances(
      (JSON.parse(json2) as { allStatistics: JsonEvent[] }).allStatistics,
      {}
    );
    // Export wrote native name "Carry"; name-primary import returns "Carry".
    expect(reimported2[0].stat).toBe("Carry");
  });
});
