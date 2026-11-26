import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "migrations");
const file = readdirSync(dir).find((f) => f.startsWith("015_"));
const sql = file ? readFileSync(join(dir, file), "utf8").toLowerCase() : "";
const FUNCS = ["gameface_fixture_allocations_list", "gameface_fixture_allocate", "gameface_fixture_unallocate"];

describe("migration 015", () => {
  it("exists", () => {
    expect(file).toBe("015_gameface_fixture_allocations.sql");
  });
  it("enforces one active allocation per fixture and locks the table", () => {
    expect(sql).toMatch(/create unique index if not exists[\s\S]*\(comp_fixture_id\)\s*where unallocated_at is null/);
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("revoke all on gameface_deputy.fixture_allocations from public, anon, authenticated");
  });
  it.each(FUNCS)("%s is security definer, admin-checked, service_role only", (name) => {
    const start = sql.indexOf(`create or replace function public.${name}(`);
    expect(start).toBeGreaterThan(-1);
    const rest = sql.slice(start + 10);
    const next = rest.indexOf("create or replace function");
    const body = rest.slice(0, next === -1 ? undefined : next);
    expect(body).toContain("security definer");
    expect(body).toContain("perform public.activity_assert_admin(p_username, p_password)");
    expect(sql).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated`));
    expect(sql).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`));
  });
  it("never grants to anon or authenticated", () => {
    expect(sql).not.toMatch(/grant[^;]*\bto\b[^;]*\b(anon|authenticated)\b/);
  });
  it("checks fixture sport and shift state", () => {
    expect(sql).toContain("fixture_not_allocatable");
    expect(sql).toContain("shift_not_allocatable");
    expect(sql).toContain("already_allocated");
  });
  it("stays isolated from Premier Data and vision download", () => {
    for (const word of ["public.comp_fixture_assignments", "tt_games", "download", "assignfixture"]) {
      expect(sql).not.toContain(word);
    }
  });
});
