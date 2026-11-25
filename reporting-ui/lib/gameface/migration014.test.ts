import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const sql = fs.readFileSync(path.resolve(__dirname, "..", "..", "migrations", "014_gameface_deputy.sql"), "utf8");
// Executable SQL only (drop "-- ..." comment lines, which hold the VERIFY/ROLLBACK notes).
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("migration 014", () => {
  it("locks the schema down", () => {
    expect(code).toContain("revoke all on schema gameface_deputy from public, anon, authenticated");
    expect(code).toContain("grant usage on schema gameface_deputy to service_role");
  });
  it("grants nothing to anon or authenticated", () => {
    expect(code).not.toMatch(/grant[^;]*\bto\b[^;]*\b(anon|authenticated)\b/i);
  });
  it("enables RLS on every table", () => {
    const tables = (code.match(/create table if not exists gameface_deputy\.(\w+)/g) ?? []).map((m) => m.split(".")[1]);
    expect(tables).toHaveLength(8);
    for (const t of tables) expect(code).toMatch(new RegExp(`alter table gameface_deputy\\.${t}\\s+enable row level security`));
  });
  it("adds the three page permissions with analyst denied", () => {
    expect(code).toContain("('super_admin', 'gameface-deputy', true)");
    expect(code).toContain("('admin',       'gameface-deputy', true)");
    expect(code).toContain("('analyst',     'gameface-deputy', false)");
  });
  it("does not touch the existing deputy cron jobs", () => {
    expect(sql).not.toContain("deputy-daily-timesheet-sync");
    expect(sql).not.toContain("deputy-noon-timesheet-sync");
  });
  it("only schedules gameface-deputy-* jobs", () => {
    const names = [...code.matchAll(/cron\.schedule\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(names.length).toBe(2);
    for (const n of names) expect(n.startsWith("gameface-deputy-")).toBe(true);
  });
  it("contains no secrets or hosts", () => {
    expect(sql).not.toContain("eyJ");
    expect(sql).not.toMatch(/\.deputy\.com/);
  });
});