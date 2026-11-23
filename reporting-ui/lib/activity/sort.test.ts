import { describe, expect, it } from "vitest";
import { nextSort, rowComparator, type SortableRow } from "./sort";

const row = (o: Partial<SortableRow> & { username: string }): SortableRow => ({
    name: o.username,
    status: "offline",
    sectionText: null,
    firstActive: null,
    lastActive: null,
    workedMs: 0,
    eventCount: 0,
    ...o,
});

const names = (rows: SortableRow[], s: Parameters<typeof rowComparator>[0]) =>
    [...rows].sort(rowComparator(s)).map((r) => r.username);

const rows = [
    row({ username: "bob", status: "offline", workedMs: 50, firstActive: 300, eventCount: 1 }),
    row({ username: "amy", status: "active", workedMs: 10, firstActive: 100, eventCount: 9, sectionText: "Chat" }),
    row({ username: "cat", status: "idle", workedMs: 90, eventCount: 4, sectionText: "Admin" }),
];

describe("rowComparator", () => {
    it("uses the default order when no sort is set", () => {
        expect(names(rows, null)).toEqual(["amy", "cat", "bob"]);
    });
    it("sorts users by name both ways", () => {
        expect(names(rows, { key: "user", dir: "asc" })).toEqual(["amy", "bob", "cat"]);
        expect(names(rows, { key: "user", dir: "desc" })).toEqual(["cat", "bob", "amy"]);
    });
    it("sorts status logically", () => {
        expect(names(rows, { key: "status", dir: "asc" })).toEqual(["amy", "cat", "bob"]);
        expect(names(rows, { key: "status", dir: "desc" })).toEqual(["bob", "cat", "amy"]);
    });
    it("sorts numbers and keeps empty values last in both directions", () => {
        expect(names(rows, { key: "worked", dir: "desc" })).toEqual(["cat", "bob", "amy"]);
        expect(names(rows, { key: "first", dir: "asc" })).toEqual(["amy", "bob", "cat"]);
        expect(names(rows, { key: "first", dir: "desc" })).toEqual(["bob", "amy", "cat"]);
        expect(names(rows, { key: "section", dir: "asc" })).toEqual(["cat", "amy", "bob"]);
    });
});

describe("nextSort", () => {
    it("starts a column in its natural direction, then toggles", () => {
        const a = nextSort(null, "worked");
        expect(a).toEqual({ key: "worked", dir: "desc" });
        expect(nextSort(a, "worked")).toEqual({ key: "worked", dir: "asc" });
        expect(nextSort(a, "user")).toEqual({ key: "user", dir: "asc" });
    });
});
