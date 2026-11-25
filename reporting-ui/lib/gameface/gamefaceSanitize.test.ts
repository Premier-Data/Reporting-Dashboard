import { describe, it, expect } from "vitest";
import { isSensitiveKey, scrubValue, prepareRow, summariseDryRun } from "../../supabase/functions/gameface-deputy-sync/sanitize";
import { RESOURCE_MAP, type Json } from "../../supabase/functions/deputy-sync/mappers";
import employees from "./fixtures/employee.json";
import rosters from "./fixtures/roster.json";
import timesheets from "./fixtures/timesheet.json";

describe("isSensitiveKey", () => {
  it("flags personal, credential and pay-rate names", () => {
    for (const k of ["Email", "PrimaryEmail", "DateOfBirth", "MainAddress", "Mobile", "Phone", "TaxFileNumber", "BankAccount", "BSB", "Photo", "PinCode", "Pin", "HourlyRate", "BaseRate", "SuperFund", "Password", "ApiToken", "PassportNumber", "DriversLicence"]) {
      expect(isSensitiveKey(k), k).toBe(true);
    }
  });
  it("keeps the fields the pages need", () => {
    for (const k of ["Cost", "OnCost", "Supervisor", "PayRuleApproved", "Employee", "Mealbreak", "TotalTime", "StartTime", "FirstName", "DisplayName"]) {
      expect(isSensitiveKey(k), k).toBe(false);
    }
  });
});

describe("scrubValue", () => {
  it("drops sensitive keys at any depth, including inside arrays", () => {
    const { value, dropped } = scrubValue(employees[0]);
    const text = JSON.stringify(value);
    expect(text).not.toMatch(/alex@example|1990-01-01|0400000000|000000000|1234|Fake St|x\.png/);
    expect(text).toContain("keep");
    expect(dropped).toEqual(expect.arrayContaining(["Email", "DateOfBirth", "MainAddress", "PinCode", "Pin", "BankAccount"]));
  });
  it("keeps Cost and OnCost", () => {
    const { value } = scrubValue(rosters[0]) as { value: Json };
    expect(value.Cost).toBe(150.5);
    expect(value.OnCost).toBe(15.2);
    expect(value.Supervisor).toBe(101);
  });
});

describe("prepareRow", () => {
  it("nulls the Employee email column and scrubs source_data", () => {
    const src = employees[0] as Json;
    const mapped = RESOURCE_MAP.Employee.mapper(src);
    expect(mapped.email).toBe("alex@example.invalid");
    const { row } = prepareRow("Employee", mapped, src);
    expect(row.email).toBeNull();
    expect(row.deputy_id).toBe("100");
    expect(row.first_name).toBe("Alex");
    expect(JSON.stringify(row.source_data)).not.toContain("alex@example");
  });
  it("keeps ids and times intact for rosters", () => {
    const src = rosters[0] as Json;
    const mapped = RESOURCE_MAP.Roster.mapper(src);
    const { row } = prepareRow("Roster", mapped, src);
    expect(row.deputy_id).toBe("1001");
    expect(row.start_time_epoch).toBe(1777849200);
    expect(row.cost).toBe(150.5);
    expect(row.roster_date).toBe("2026-05-04");
  });
});

describe("summariseDryRun", () => {
  it("returns names and counts only", () => {
    const src = employees as Json[];
    const mapped = src.map((r) => RESOURCE_MAP.Employee.mapper(r));
    const s = summariseDryRun("Employee", src, mapped, ["Email"]);
    expect(s.read).toBe(2);
    expect(s.droppedFieldNames).toEqual(expect.arrayContaining(["Email", "MainAddress", "PrimaryEmail"]));
    expect(s.keptFieldNames).toContain("FirstName");
    expect(s.keptFieldNames).not.toContain("Email");
    expect(JSON.stringify(s)).not.toContain("example.invalid");
  });
  it("finds zero date mismatches for correct Sydney bucketing, including the evening-UTC shift", () => {
    const src = rosters as Json[];
    const mapped = src.map((r) => RESOURCE_MAP.Roster.mapper(r));
    expect(mapped[4].roster_date).toBe("2026-05-08");
    const s = summariseDryRun("Roster", src, mapped, []);
    expect(s.dateMismatches).toBe(0);
    expect(s.minDate).toBe("2026-05-04");
    expect(s.maxDate).toBe("2026-05-08");
  });
  it("counts a deliberately shifted Date as a mismatch", () => {
    const src = (timesheets as Json[]).map((r, i) => (i === 0 ? { ...r, Date: "2026-05-09T00:00:00+10:00" } : r));
    const mapped = src.map((r) => RESOURCE_MAP.Timesheet.mapper(r));
    expect(summariseDryRun("Timesheet", src, mapped, []).dateMismatches).toBe(1);
  });
});