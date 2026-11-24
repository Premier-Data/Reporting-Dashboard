import { describe, expect, it } from "vitest";
import {
  addObjects,
  buildSnapshot,
  type FolderTotals,
  type RunningTotals,
} from "../../../playhq-worker/src/r2Report";

function scan(pages: { key: string; size: number }[][]) {
  const totals: FolderTotals = {};
  const running: RunningTotals = { files: 0, bytes: 0 };
  for (const p of pages) addObjects(totals, p, running);
  return buildSnapshot(totals, running, "2025-01-01T00:00:00.000Z");
}

describe("r2Report aggregation", () => {
  it("parent totals include nested folders", () => {
    const snap = scan([
      [
        { key: "AFL/2025/a.mp4", size: 100 },
        { key: "AFL/2025/b.mp4", size: 50 },
        { key: "AFL/c.mp4", size: 10 },
      ],
    ]);
    const by = Object.fromEntries(snap.folders.map((f) => [f.prefix, f]));
    expect(by["AFL/"]).toMatchObject({ files: 3, bytes: 160 });
    expect(by["AFL/2025/"]).toMatchObject({ files: 2, bytes: 150 });
    expect(snap.totalFiles).toBe(3);
    expect(snap.totalBytes).toBe(160);
    expect(snap.bucket).toBe("video");
  });

  it("folder markers create folders and ancestors, add bytes, are not files", () => {
    const snap = scan([[{ key: "A/B/empty/", size: 0 }, { key: "A/B/x/", size: 5 }]]);
    const by = Object.fromEntries(snap.folders.map((f) => [f.prefix, f]));
    expect(by["A/"]).toMatchObject({ files: 0, bytes: 5 });
    expect(by["A/B/"]).toMatchObject({ files: 0, bytes: 5 });
    expect(by["A/B/empty/"]).toMatchObject({ files: 0, bytes: 0 });
    expect(snap.totalFiles).toBe(0);
  });

  it("root-level key counts only toward bucket totals", () => {
    const snap = scan([[{ key: "root.mp4", size: 42 }]]);
    expect(snap.folders).toEqual([]);
    expect(snap.totalFiles).toBe(1);
    expect(snap.totalBytes).toBe(42);
  });

  it("empty bucket gives zero totals and no folders", () => {
    const snap = scan([[]]);
    expect(snap.folders).toEqual([]);
    expect(snap.totalFiles).toBe(0);
    expect(snap.totalBytes).toBe(0);
  });

  it("incremental pages equal one pass", () => {
    const objs = [
      { key: "a/1.mp4", size: 1 },
      { key: "a/b/2.mp4", size: 2 },
      { key: "c/3.mp4", size: 3 },
      { key: "c/d/", size: 0 },
      { key: "top.mp4", size: 4 },
    ];
    const one = scan([objs]);
    const paged = scan([objs.slice(0, 2), objs.slice(2, 3), objs.slice(3)]);
    expect(paged).toEqual(one);
  });

  it("sorts by bytes desc, ties by prefix asc", () => {
    const snap = scan([
      [
        { key: "b/1.mp4", size: 10 },
        { key: "a/1.mp4", size: 10 },
        { key: "c/1.mp4", size: 99 },
      ],
    ]);
    expect(snap.folders.map((f) => f.prefix)).toEqual(["c/", "a/", "b/"]);
  });
});
