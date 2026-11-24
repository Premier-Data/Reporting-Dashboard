import { describe, expect, it } from "vitest";
import type { FolderRow } from "../../../playhq-worker/src/r2Report";
import { buildVisibleRows, formatBytes } from "./folderTree";
import { r2StorageCsv } from "../exports/r2StorageExcel";

const GB = 1024 ** 3;
const folders: FolderRow[] = [
    { prefix: "AFL/", files: 10, bytes: 8 * GB },
    { prefix: "AFL/2024/", files: 3, bytes: 2 * GB },
    { prefix: "AFL/2025/", files: 7, bytes: 6 * GB },
    { prefix: "NPL/", files: 4, bytes: 9 * GB },
    { prefix: "NPL/Final/", files: 1, bytes: 1 * GB },
];

describe("buildVisibleRows", () => {
    it("shows collapsed top-level folders largest first", () => {
        const rows = buildVisibleRows(folders, new Set(), "");
        expect(rows.map((r) => r.prefix)).toEqual(["NPL/", "AFL/"]);
        expect(rows[0]).toMatchObject({ name: "NPL", depth: 0, hasChildren: true, pctOfParent: null });
    });

    it("nests expanded children sorted largest first", () => {
        const rows = buildVisibleRows(folders, new Set(["AFL/"]), "");
        expect(rows.map((r) => r.prefix)).toEqual(["NPL/", "AFL/", "AFL/2025/", "AFL/2024/"]);
        expect(rows[2]).toMatchObject({ name: "2025", depth: 1, hasChildren: false });
        expect(rows[2].pctOfParent).toBeCloseTo(75);
    });

    it("search keeps matches and their ancestors, opened", () => {
        const rows = buildVisibleRows(folders, new Set(), "2025");
        expect(rows.map((r) => r.prefix)).toEqual(["AFL/", "AFL/2025/"]);
        expect(buildVisibleRows(folders, new Set(), "final").map((r) => r.prefix)).toEqual(["NPL/", "NPL/Final/"]);
    });

    it("returns nothing when the search matches nothing", () => {
        expect(buildVisibleRows(folders, new Set(), "zzz")).toEqual([]);
    });
});

describe("formatBytes", () => {
    it("uses GB below 1 TB and TB from 1 TB", () => {
        expect(formatBytes(0)).toBe("0.00 GB");
        expect(formatBytes(1.5 * GB)).toBe("1.50 GB");
        expect(formatBytes(1024 ** 4 - 1)).toBe("1024.00 GB");
        expect(formatBytes(1024 ** 4)).toBe("1.00 TB");
        expect(formatBytes(2.5 * 1024 ** 4)).toBe("2.50 TB");
    });
});

describe("r2StorageCsv", () => {
    it("quotes folder names containing commas and quotes", () => {
        const csv = r2StorageCsv({
            bucket: "video",
            scannedAt: "2025-01-01T00:00:00.000Z",
            totalFiles: 2,
            totalBytes: 3,
            folders: [{ prefix: 'a,"b"/', files: 2, bytes: 3 }],
        });
        const lines = csv.split("\r\n");
        expect(lines[0]).toBe("Folder,Files,Size_GB,Size_TB,Size_Bytes");
        expect(lines[1]).toBe('"a,""b""/",2,0,0,3');
    });
});
