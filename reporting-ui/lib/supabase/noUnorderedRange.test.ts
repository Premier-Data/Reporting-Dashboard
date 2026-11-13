// Permanent guard: every PostgREST `.range(` page loop must be ordered by a
// UNIQUE key before the `.range(`, otherwise offset paging can read rows twice
// or skip them (PostgREST caps responses at 1000 rows, so paging is required).
// Allowed unique keys (each is the real primary/unique key of its table):
//   game_key (TT_Games, soccer_games), shift_key (weekly_report_shifts view),
//   id (accuracy_*, comp_fixtures, teams), competition_uid (comp_sources),
//   deputy_id (deputy.* tables), unit_name (deputy_area_map), name (vn_team,
//   9 rows, one page; names verified unique).
// Only `.order("<key>"` calls count; a business-only order such as Date does not.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const SCAN_DIRS = ["app", "components", "lib"];
const SKIP_SEGMENTS = new Set(["node_modules", ".next", "out", ".agents"]);
const THIS_FILE = "lib/supabase/noUnorderedRange.test.ts";
export const UNIQUE_KEYS = ["game_key", "shift_key", "id", "competition_uid", "deputy_id", "unit_name", "name"];
const KEY_ORDER = new RegExp(`\\.order\\([^)]*["'\`](?:${UNIQUE_KEYS.join("|")})["'\`]`);
// Escape hatch for chains built elsewhere (helper loops, a shared build() query):
// put `// paged-order-ok: <reason>` on a line within the lookback window.
const MARKER = /paged-order-ok:/;
const LOOKBACK_LINES = 14;

/** Returns violations: `.range(` calls without a unique-key `.order(` in the same chain. */
export function scan(relPath: string, text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!/\.range\(\s*\w+\s*,/.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
    // Walk back through the chain (stop at a statement boundary).
    const chain: string[] = [line.slice(0, line.indexOf(".range("))];
    for (let j = i - 1; j >= 0 && j >= i - LOOKBACK_LINES; j--) {
      chain.unshift(lines[j]);
      if (/(^|\s)(const|let|var)\s|;\s*$|^\s*\}\s*$/.test(lines[j]) && !/await|\.from\(|\.select\(/.test(lines[j])) break;
      if (/\.from\(/.test(lines[j]) || /\bbuild\b|\bq\b\s*=/.test(lines[j])) break;
    }
    const joined = chain.join("\n");
    if (!KEY_ORDER.test(joined) && !MARKER.test(joined)) out.push(`${relPath}:${i + 1}: .range() without unique-key .order()`);
  });
  return out;
}

function walk(dir: string, acc: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_SEGMENTS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) acc.push(full);
  }
}

describe("paged Supabase reads are ordered by a unique key", () => {
  it("flags a business-only order and accepts a unique tiebreak", () => {
    const bad = `await supabase.from("TT_Games").select("*").order("Date").order("Competition")\n.range(from, to);`;
    const good = `await supabase.from("TT_Games").select("*").order("Date").order("game_key")\n.range(from, to);`;
    expect(scan("x.ts", bad)).toHaveLength(1);
    expect(scan("x.ts", good)).toHaveLength(0);
  });

  it("has no unordered .range() in app/, components/, lib/", () => {
    const files: string[] = [];
    for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);
    const violations = files.flatMap((f) => {
      const rel = path.relative(ROOT, f).replace(/\\/g, "/");
      return rel === THIS_FILE ? [] : scan(rel, fs.readFileSync(f, "utf8"));
    });
    expect(violations).toEqual([]);
  });
});
