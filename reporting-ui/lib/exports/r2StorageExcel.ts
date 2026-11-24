// Excel / CSV export of the R2 "video" bucket folder sizes.
// All folders are listed flat, largest first. Parent folders include their
// nested folders, so do not add parent and child rows together.
import type { R2Snapshot } from "../../../playhq-worker/src/r2Report";

const GB = 1024 ** 3;
const TB = 1024 ** 4;
const HEADERS = ["Folder", "Files", "Size_GB", "Size_TB", "Size_Bytes"];

const gb = (b: number) => Math.round((b / GB) * 100) / 100;
const tb = (b: number) => Math.round((b / TB) * 1000) / 1000;

function csvCell(v: string | number): string {
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function r2StorageCsv(snap: R2Snapshot): string {
    const lines = [HEADERS.join(",")];
    for (const f of snap.folders) {
        lines.push([f.prefix, f.files, gb(f.bytes), tb(f.bytes), f.bytes].map(csvCell).join(","));
    }
    lines.push(["TOTAL (bucket)", snap.totalFiles, gb(snap.totalBytes), tb(snap.totalBytes), snap.totalBytes].map(csvCell).join(","));
    return lines.join("\r\n") + "\r\n";
}

function download(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

const stamp = (snap: R2Snapshot) => snap.scannedAt.slice(0, 10);

export function exportR2StorageCsv(snap: R2Snapshot) {
    download(new Blob([r2StorageCsv(snap)], { type: "text/csv;charset=utf-8" }), `r2-${snap.bucket}-folder-sizes_${stamp(snap)}.csv`);
}

export async function exportR2StorageExcel(snap: R2Snapshot) {
    // Loaded on demand so exceljs stays out of the main bundle.
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("R2 Storage");

    ws.getCell(1, 1).value = `Bucket: ${snap.bucket}   Scanned at: ${new Date(snap.scannedAt).toLocaleString()}`;
    ws.getCell(1, 1).font = { italic: true, size: 9, color: { argb: "FF666666" } };

    const header = ws.getRow(3);
    HEADERS.forEach((h, i) => {
        const c = header.getCell(i + 1);
        c.value = h;
        c.font = { bold: true };
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };
    });

    let r = 4;
    for (const f of snap.folders) {
        ws.getRow(r++).values = [f.prefix, f.files, gb(f.bytes), tb(f.bytes), f.bytes];
    }
    const total = ws.getRow(r);
    total.values = ["TOTAL (bucket)", snap.totalFiles, gb(snap.totalBytes), tb(snap.totalBytes), snap.totalBytes];
    total.font = { bold: true };

    ws.getColumn(1).width = 60;
    for (const col of [2, 3, 4, 5]) ws.getColumn(col).width = 16;
    ws.getColumn(2).numFmt = "#,##0";
    ws.getColumn(3).numFmt = "#,##0.00";
    ws.getColumn(4).numFmt = "#,##0.000";
    ws.getColumn(5).numFmt = "#,##0";
    ws.views = [{ state: "frozen", ySplit: 3 }];

    const buf = await wb.xlsx.writeBuffer();
    download(
        new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
        `r2-${snap.bucket}-folder-sizes_${stamp(snap)}.xlsx`
    );
}
