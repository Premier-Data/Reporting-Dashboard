import { describe, it, expect } from "vitest";
import { EMPLOYEE_ALIASES, applyEmployeeAlias } from "./employeeAliases";

describe("applyEmployeeAlias", () => {
  it("maps the Deputy name to the TT_Games name, case-insensitively", () => {
    expect(applyEmployeeAlias("Jimmy Dwyer")).toBe("Jimmy New Dwyer");
    expect(applyEmployeeAlias("JIMMY DWYER")).toBe("Jimmy New Dwyer");
  });
  it("leaves other names alone", () => {
    expect(applyEmployeeAlias("James Dwyer")).toBe("James Dwyer");
  });
  it("is a single entry", () => {
    expect(Object.keys(EMPLOYEE_ALIASES)).toEqual(["jimmy dwyer"]);
  });
});
