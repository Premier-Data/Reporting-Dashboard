// Pure folder aggregation for the R2 storage report. No imports and no Worker
// types, so both the Worker and the Vitest suite (reporting-ui/lib/r2) load it.
//
// Rules:
//  - Key "a/b/c.mp4" adds its size and +1 file to prefixes "a/" and "a/b/".
//  - A key with no "/" counts only toward the bucket total.
//  - A folder marker (key ends with "/") creates the folder and all its
//    ancestors (so empty folders appear) and adds its bytes, but is not
//    counted as a file, neither in the folders nor in the bucket total.
//  - Parent totals include all descendants.

export type FolderTotals = Record<string, { files: number; bytes: number }>;

export interface RunningTotals {
  files: number;
  bytes: number;
}

export interface R2Object {
  key: string;
  size: number;
}

export interface FolderRow {
  prefix: string;
  files: number;
  bytes: number;
}

export interface R2Snapshot {
  bucket: string;
  scannedAt: string;
  totalFiles: number;
  totalBytes: number;
  folders: FolderRow[];
}

export function addObjects(
  totals: FolderTotals,
  objs: R2Object[],
  running: RunningTotals
): void {
  for (const obj of objs) {
    const key = obj.key;
    const size = Number.isFinite(obj.size) ? obj.size : 0;
    const isMarker = key.endsWith("/");
    const parts = key.split("/");
    // For a marker the last element is "" so parts.length - 1 folders remain
    // after dropping it; for a file the last element is the file name.
    const depth = parts.length - 1;

    if (!isMarker) {
      running.files += 1;
      running.bytes += size;
    }

    let prefix = "";
    for (let i = 0; i < depth; i++) {
      prefix += parts[i] + "/";
      if (prefix === "/") continue; // key started with "/": no empty-name folder
      const t = (totals[prefix] ??= { files: 0, bytes: 0 });
      t.bytes += size;
      if (!isMarker) t.files += 1;
    }
  }
}

export function buildSnapshot(
  totals: FolderTotals,
  running: RunningTotals,
  scannedAt: string
): R2Snapshot {
  const folders: FolderRow[] = Object.keys(totals).map((prefix) => ({
    prefix,
    files: totals[prefix].files,
    bytes: totals[prefix].bytes,
  }));
  folders.sort((a, b) =>
    b.bytes !== a.bytes ? b.bytes - a.bytes : a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0
  );
  return {
    bucket: "video",
    scannedAt,
    totalFiles: running.files,
    totalBytes: running.bytes,
    folders,
  };
}
