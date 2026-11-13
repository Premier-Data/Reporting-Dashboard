// Map PlayHQ club logos to your team names and write them into Supabase.
//
// Prereq: paste the browser-console output (see playhq_console_snippet.js)
// into scripts/playhq_logos.json — an array of { name, logo }.
//
// Usage:
//   node scripts/map_playhq_logos.mjs           (dry run — shows matches)
//   node scripts/map_playhq_logos.mjs --write    (upsert into `teams`)
//
// Matching: your team names (from TT_Games home_team/away_team) are matched to
// PlayHQ club names case-insensitively, ignoring common age/grade suffixes and
// punctuation, using exact -> suffix -> containment -> token-overlap.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://uizimmfujhpuiqhjofzf.supabase.co";
// Service key (writes bypass any policies; RLS is disabled on these tables).
const SERVICE_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpemltbWZ1amhwdWlxaGpvZnpmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTU3NTYzMiwiZXhwIjoyMDk3MTUxNjMyfQ.kKp06R1o7gYu6EexlkKgFhAYiSSWlNIThfekPjneO38";
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const WRITE = process.argv.includes("--write");

// --- Load the PlayHQ logo list ---
let playhq;
try {
    playhq = JSON.parse(readFileSync("scripts/playhq_logos.json", "utf8"));
} catch {
    console.error(
        "Missing scripts/playhq_logos.json. Run playhq_console_snippet.js in the browser first and save its JSON there."
    );
    process.exit(1);
}
if (!Array.isArray(playhq) || playhq.length === 0) {
    console.error("playhq_logos.json is empty or not an array.");
    process.exit(1);
}

// --- Optional manual overrides (exclude / force) ---
let overrides = { exclude: [], force: {} };
try {
    const raw = JSON.parse(readFileSync("scripts/logo_overrides.json", "utf8"));
    overrides = { exclude: raw.exclude ?? [], force: raw.force ?? {} };
} catch {
    // no overrides file — fine.
}
const excludeSet = new Set(
    (overrides.exclude || []).map((s) => s.trim().toLowerCase())
);
const forceMap = new Map(
    Object.entries(overrides.force || {}).map(([k, v]) => [
        k.trim().toLowerCase(),
        v,
    ])
);

// --- Normalisation ---
const SUFFIXES = [
    "reserves", "reserve", "seniors", "senior", "colts", "thirds", "twos",
    "women", "womens", "men", "mens", "fc", "sc", "afc", "cc",
];
function norm(s) {
    let t = (s || "").toLowerCase();
    t = t.replace(/[^a-z0-9 ]+/g, " ");          // strip punctuation
    t = t.replace(/\bu\s?\d{1,2}s?\b/g, " ");     // remove U13 / U15s age groups
    t = t.replace(/\b(boys|girls)\b/g, " ");      // remove boys/girls
    t = t.replace(/\b\d{1,2}s?\b/g, " ");         // stray age numbers
    let words = t.split(/\s+/).filter(Boolean);
    // Drop trailing generic club suffixes.
    while (words.length > 1 && SUFFIXES.includes(words[words.length - 1])) {
        words.pop();
    }
    return words.join(" ").trim();
}
// Best PlayHQ match for a team name; returns { logo, phqName, how } or null.
//
// Strict, word-boundary-aligned matching only (no loose token overlap, which
// produced false positives like "North Geelong" -> "Geelong West Giants"):
//   - exact normalised names, OR
//   - one normalised name is a leading-word prefix of the other
//     ("Colac" <-> "Colac Tigers", "Geelong West" <-> "Geelong West Giants").
// A single shared word in the MIDDLE/END (e.g. both contain "Barwon" or
// "Geelong") is NOT enough.
function matchTeam(teamName) {
    const n = norm(teamName);
    if (!n) return null;
    const nWords = n.split(" ");

    // 1) exact normalised
    for (const p of playhq) if (norm(p.name) === n) return { ...p, how: "exact" };

    // 2) leading-prefix match (word-aligned, from the start)
    for (const p of playhq) {
        const pn = norm(p.name);
        if (!pn) continue;
        const pWords = pn.split(" ");
        const shorter = pWords.length <= nWords.length ? pWords : nWords;
        const longer = pWords.length <= nWords.length ? nWords : pWords;
        // Every word of the shorter name must equal the leading words of the
        // longer name, in order.
        const isPrefix = shorter.every((w, i) => longer[i] === w);
        if (isPrefix) return { ...p, how: "prefix" };
    }

    return null;
}

// --- Load distinct team names from TT_Games ---
async function loadTeamNames() {
    const names = new Set();
    const pageSize = 1000;
    let from = 0;
    while (true) {
        const { data, error } = await supabase
            .from("TT_Games")
            .select("home_team, away_team")
            .order("game_key", { ascending: true })
            .range(from, from + pageSize - 1);
        if (error) {
            console.error("Failed loading TT_Games:", error.message);
            break;
        }
        if (!data || data.length === 0) break;
        for (const r of data) {
            if (r.home_team?.trim()) names.add(r.home_team.trim());
            if (r.away_team?.trim()) names.add(r.away_team.trim());
        }
        from += pageSize;
        if (data.length < pageSize) break;
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
}

const teamNames = await loadTeamNames();
console.log(`Loaded ${teamNames.length} distinct team names, ${playhq.length} PlayHQ logos.\n`);

// Existing logos, to skip already-mapped teams.
const { data: existing } = await supabase.from("teams").select("team_name, logo_url");
const already = new Map(
    (existing ?? [])
        .filter((t) => t.logo_url)
        .map((t) => [t.team_name.trim().toLowerCase(), t.logo_url])
);

const toWrite = [];
const unmatched = [];
for (const team of teamNames) {
    const lower = team.toLowerCase();
    if (already.has(lower)) continue; // keep existing mapping
    if (excludeSet.has(lower)) {
        console.log(`  SKIP   "${team}"  (excluded via overrides)`);
        continue;
    }
    // Forced mapping wins.
    if (forceMap.has(lower)) {
        toWrite.push({ team_name: team, logo_url: forceMap.get(lower) });
        console.log(`  FORCE  "${team}"  (override)`);
        continue;
    }
    const m = matchTeam(team);
    if (m) {
        toWrite.push({ team_name: team, logo_url: m.logo });
        console.log(`  MATCH  "${team}"  ->  "${m.phqName ?? m.name}"  [${m.how}]`);
    } else {
        unmatched.push(team);
    }
}

console.log(`\n${toWrite.length} to map, ${unmatched.length} unmatched.`);
if (unmatched.length) {
    console.log("\nUnmatched teams:");
    for (const u of unmatched) console.log("  " + u);
}

if (WRITE && toWrite.length) {
    // team_name has a unique constraint (teams_team_name_key), so upsert on it.
    const { error } = await supabase
        .from("teams")
        .upsert(toWrite, { onConflict: "team_name" });
    if (error) console.error("\nUpsert failed:", error.message);
    else console.log(`\nWrote ${toWrite.length} logo mappings to teams.`);
} else if (!WRITE) {
    console.log("\nDry run — re-run with --write to save these mappings.");
}
