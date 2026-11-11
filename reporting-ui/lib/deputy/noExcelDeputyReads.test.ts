// Permanent guard: Deputy data must come from the Deputy API, never from the
// Excel-loaded tables. Fails when the guarded table names (or any other
// `deputy_*` table read, except deputy_area_map) appear anywhere in reporting-ui
// outside the IGNORE list below. Comments count, so keep comments reworded.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const THIS_FILE = "lib/deputy/noExcelDeputyReads.test.ts";

/** Directory or file names (matched on any path segment / the relative path) that are not scanned. */
export const IGNORE = [
  "node_modules",
  ".next",
  "out",
  ".git",
  ".agents",
  "migrations", // SQL history and the lock/replace migrations name the tables
  "docs",
  "sync-deputy.js", // legacy Excel sync writer (service key)
  "syncDeputyRoster.js",
  "README.md",
  "package-lock.json",
  THIS_FILE,
];
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".sql", ".md", ".css"]);

const BANNED_NAME = /deputy_(?:shifts|roster)(?![a-z])/i;
const OTHER_DEPUTY_FROM = /\.from\(\s*["'`]deputy_(?!area_map["'`])/i;

/** Returns a description for every violation in `text` (empty when clean). */
export function scan(relPath: string, text: string): string[] {
  const out: string[] = [];
  if (BANNED_NAME.test(text)) out.push(`${relPath}: mentions deputy_shifts / deputy_roster`);
  if (OTHER_DEPUTY_FROM.test(text)) out.push(`${relPath}: reads a deputy_* table other than deputy_area_map`);
  return out;
}

function isIgnored(rel: string): boolean {
  const segs = rel.split("/");
  const base = segs[segs.length - 1];
  if (base.startsWith(".env")) return true;
  return IGNORE.some((i) => rel === i || segs.includes(i));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    if (isIgnored(rel)) continue;
    if (entry.isDirectory()) walk(abs, out);
    else if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) out.push(rel);
  }
  return out;
}

describe("scan (self-test)", () => {
  it.each([
    "deputy_shifts",
    "DEPUTY_SHIFTS",
    "deputy_roster",
    ".from('deputy_shifts')",
    "supabase.from(`deputy_foo`)",
    '.from(\n  "deputy_bar")',
  ])("flags %j", (text) => {
    expect(scan("x.ts", text).length).toBeGreaterThan(0);
  });

  it.each([
    "deputy_area_map",
    '.from("deputy_area_map")',
    "deputy_rosters_idx",
    "deputy.timesheets",
  ])("passes %j", (text) => {
    expect(scan("x.ts", text)).toEqual([]);
  });
});

describe("no Excel Deputy reads", () => {
  const files = walk(ROOT);

  it("scans a meaningful number of files", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("lib/api/deputyShifts.ts");
    expect(files).not.toContain("sync-deputy.js");
  });

  it("finds no deputy_shifts / deputy_roster (or other deputy_* table) reads", () => {
    const violations = files.flatMap((rel) => scan(rel, fs.readFileSync(path.join(ROOT, rel), "utf8")));
    expect(violations).toEqual([]);
  });

  it("references the weekly_report_shifts view only from the shared data layer", () => {
    const users = files
      .filter((rel) => !/\.test\.tsx?$/.test(rel))
      .filter((rel) =>
      fs.readFileSync(path.join(ROOT, rel), "utf8").includes("weekly_report_shifts")
    );
    expect(users.sort()).toEqual(["lib/api/deputyShifts.ts"]);
  });
});
