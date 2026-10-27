const axios = require("axios");
const XLSX = require("xlsx");
const { createClient } = require("@supabase/supabase-js");

// ----------------------
// ENV
// ----------------------
if (process.env.CI !== "true") {
  require("dotenv").config();
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CHUNK_SIZE = 500;

let syncLogId = null;

// ----------------------
// LOGGING
// ----------------------
async function logStart(source) {
  const { data, error } = await supabase
    .from("sync_logs")
    .insert({
      source,
      started_at: new Date(),
      status: "running",
      row_count: 0,
    })
    .select()
    .single();

  if (error) throw error;

  syncLogId = data.id;
}

async function logSuccess(rowCount) {
  if (!syncLogId) return;

  await supabase
    .from("sync_logs")
    .update({
      finished_at: new Date(),
      status: "success",
      row_count: rowCount,
    })
    .eq("id", syncLogId);
}

async function logFailure(err) {
  if (!syncLogId) return;

  await supabase
    .from("sync_logs")
    .update({
      finished_at: new Date(),
      status: "failed",
      error_message: err.message || String(err),
    })
    .eq("id", syncLogId);
}

// ----------------------
// HELPERS
// ----------------------
function excelTimeToString(value) {
  if (!value) return null;

  const num = Number(value);
  if (isNaN(num)) return value;

  const totalSeconds = Math.round(num * 86400);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function excelDateToJS(value) {
  if (!value) return null;

  // Already a date string (CSV). Only accept it if it actually parses
  // to a valid date — otherwise a stray header row (value === "Date")
  // would be passed straight through and rejected by Postgres.
  if (typeof value === "string") {
    const datePart = value.split("T")[0];
    const parsed = new Date(datePart);
    if (isNaN(parsed.getTime())) {
      return null;
    }
    return datePart;
  }

  // Excel serial number (XLSX)
  const date = new Date((Number(value) - 25569) * 86400 * 1000);

  if (isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().split("T")[0];
}

// ----------------------
// SHEET PICKER
// ----------------------
// Fuzzy (substring) match. Kept for the Deputy sheet. NOTE: the TT sheet uses
// an EXACT match instead — "TTRawData" is a substring of both the old
// "TTRawData" and season sheets like "2027_TTRawData", so a fuzzy match would
// ambiguously pick whichever appears first in the workbook.
function getSheet(workbook, names) {
  const found = workbook.SheetNames.find(name =>
    names.some(n => name.toLowerCase().includes(n.toLowerCase()))
  );

  if (!found) {
    throw new Error(`Sheet not found: ${workbook.SheetNames.join(", ")}`);
  }

  return workbook.Sheets[found];
}

// Exact sheet match (case-insensitive, whitespace-trimmed). Used for the TT
// season sheet so there is no ambiguity between "TTRawData", "2027_TTRawData",
// "2028_TTRawData", etc. which all share the "TTRawData" substring.
function getSheetExact(workbook, name) {
  const target = String(name).trim().toLowerCase();
  const found = workbook.SheetNames.find(
    n => n.trim().toLowerCase() === target
  );

  if (!found) {
    throw new Error(
      `Sheet "${name}" not found. Available: ${workbook.SheetNames.join(", ")}`
    );
  }

  return workbook.Sheets[found];
}

// The active TT season sheet. Rolling to a new season each year is a one-line
// change: set TT_SHEET_NAME in the environment (e.g. TT_SHEET_NAME=2028_TTRawData).
// Defaults to the 2027 season sheet.
const TT_SHEET_NAME = process.env.TT_SHEET_NAME || "2027_TTRawData";

// Derive the season (year) from the sheet name's leading 4-digit year, e.g.
// "2027_TTRawData" -> 2027. Falls back to the current calendar year when the
// sheet name carries no year (e.g. the legacy "TTRawData"). Stamped on every TT
// row so seasons can be filtered/reported without separate tables.
function seasonFromSheetName(name) {
  const m = String(name).match(/(\d{4})/);
  return m ? Number(m[1]) : new Date().getFullYear();
}

const TT_SEASON = seasonFromSheetName(TT_SHEET_NAME);

// ----------------------
// AUTH (GRAPH)
// ----------------------
async function getToken() {
  const res = await axios.post(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: process.env.AZURE_CLIENT_ID,
      client_secret: process.env.AZURE_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    })
  );

  return res.data.access_token;
}

// ----------------------
// DOWNLOAD EXCEL
// ----------------------
async function getExcelBuffer() {
  const token = await getToken();

  const metaUrl =
    `https://graph.microsoft.com/v1.0/sites/${process.env.SITE_ID}` +
    `/drives/${process.env.DRIVE_ID}` +
    `/items/${process.env.FILE_ID}`;

  const meta = await axios.get(metaUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const downloadUrl = meta.data["@microsoft.graph.downloadUrl"];

  console.log("📥 Downloading Excel file...");

  const file = await axios.get(downloadUrl, {
    responseType: "arraybuffer",
  });

  return file.data;
}

// ----------------------
// PARSE DEPUTY
// ----------------------
function parseDeputyData(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = getSheet(workbook, ["DeputyRawData"]);

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  console.log("TT Header:", rows[0]);
  console.log("First TT Row:", rows[1]);
  console.log("Raw rows:", rows.length);

  let skipped = 0;

  const filtered = rows.slice(1).filter((r, i) => {
    if (!r || !r[0]) {
      skipped++;

      console.log(
        "Skipped row",
        i + 2,
        JSON.stringify(r)
      );

      return false;
    }

    return true;
  });

  console.log("Skipped rows:", skipped);
  console.log("Rows after filter:", filtered.length);

  return filtered.map(r => ({
    shift_key: `${r[0]}_${r[2]}_${r[3]}_${r[4]}`,

    employee_name: r[0],
    level: String(r[1] || ""),

    shift_date: excelDateToJS(r[2]),
    start_time: excelTimeToString(r[3]),
    end_time: excelTimeToString(r[4]),
    meal_break: excelTimeToString(r[5]),

    total_hours: Number(r[6]) || 0,
    total_cost: Number(r[7]) || 0,

    employee_comment: r[8] || null,
    hourly_rate: Number(r[9]) || 0,

    area_name: String(r[10] || "").trim(),

    comment: r[11] || null,
    day_name: r[12] || null,
    month_name: r[13] || null,
    week: r[14] == null || r[14] === "" ? 0 : Number(r[14]),
    source_file: "DeputyRawData",
  }));
}

// ----------------------
// PARSE TT
// ----------------------
function parseTTData(buffer) {

  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = getSheetExact(workbook, TT_SHEET_NAME);
  console.log(`📄 TT sheet: "${TT_SHEET_NAME}" (season ${TT_SEASON})`);

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  console.log("TT Header:", rows[0]);
  console.dir(rows[1], { depth: null });
  console.log("Row length:", rows[1].length);

  rows[0].forEach((header, index) => {
    console.log(index, "=", header);
  });

  rows[1].forEach((value, index) => {
    console.log(index, "=", value);
  });
  console.log("Raw videoURL value:", rows[1][13]);

  let skippedTT = 0;

  const parsed = rows
    .slice(1)
    .filter(r => r && r.length)
    .map(r => {

      // Trim + strip zero-width chars from every string field so
      // TT_Games is stored clean. Trailing/leading whitespace (or a
      // stray zero-width char) on home_team/away_team/Competition/Round
      // breaks the composite-key match against the AutoDownload API in
      // the fixtures UI: the fixture is treated as "unmatched", so it
      // never gets its file size checked and the download never starts.
      const clean = v => {
        if (v == null) return null;
        const s = String(v)
          .replace(/[\u200B-\u200D\uFEFF]/g, "")
          .replace(/\s+/g, " ")
          .trim();
        return s === "" ? null : s;
      };

      // Video URLs in the source contain literal spaces in the path
      // (e.g. ".../Champions IGA Seniors/..."). Left raw, the download
      // agent and the Cloudflare HEAD size-check can't resolve them, so
      // the fixture stays on "Checking..." and the download never
      // starts. Percent-encode ONLY the spaces (and trim/strip
      // zero-width) so the stored URL is valid without disturbing the
      // rest of the URL structure or double-encoding existing %xx.
      const cleanUrl = v => {
        const s = clean(v);
        if (s == null) return null;
        return s.replace(/ /g, "%20");
      };

      const date = excelDateToJS(r[0]);
      const home_team = clean(r[3]);
      const away_team = clean(r[4]);

      return {

        game_key: `${date}_${home_team}_${away_team}`,

        Date: date,

        Competition: clean(r[1]),
        Round: clean(r[2]),

        home_team,
        away_team,

        home_allocated: clean(r[5]),
        away_allocated: clean(r[6]),

        Location: clean(r[7]),
        Additional: clean(r[8]),

        Week:
          r[9] == null || r[9] === ""
            ? 0
            : Number(r[9]),

        Column11: clean(r[10]),      // Month

        expected_day: clean(r[11]),  // Completion day

        videoURL: cleanUrl(r[12]),

        // Season (year) this row belongs to, derived from the source sheet
        // name (TT_SHEET_NAME). Lets the UI filter/report by season without
        // separate per-year tables.
        season: TT_SEASON,

      };
    })
    // Skip malformed rows missing the fields required by the
    // TT_Games NOT NULL constraints (Date) or that have no way to
    // form a meaningful game_key (home/away team missing).
    .filter(row => {
      if (!row.Date || !row.home_team || !row.away_team) {
        skippedTT++;

        console.log(
          "⚠️ Skipping malformed TT row (missing Date/home/away):",
          JSON.stringify(row)
        );

        return false;
      }

      return true;
    });

  console.log("Skipped malformed TT rows:", skippedTT);
  console.log("First Parsed TT Row:", parsed[0]);

  return parsed;
}

// ----------------------
// DEDUPE
// ----------------------
function dedupe(records, key) {
  const map = new Map();

  for (const r of records) {
    if (map.has(r[key])) {
      console.log("\n==================================");
      console.log("DUPLICATE SHIFT FOUND");
      console.log("Key:", r[key]);
      console.log("First Row:", map.get(r[key]));
      console.log("Second Row:", r);
      console.log("==================================\n");
    }

    map.set(r[key], r);
  }

  return [...map.values()];
}
// ----------------------
// UPLOAD DEPUTY
// ----------------------
async function uploadToSupabase(records) {
  let uploaded = 0;

  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);

    console.log(
      `Uploading Deputy chunk ${i / CHUNK_SIZE + 1}:`,
      chunk.length,
      "rows"
    );

    const { error } = await supabase
      .from("deputy_shifts")
      .upsert(chunk, { onConflict: "shift_key" });

    if (error) throw new Error(JSON.stringify(error));

    uploaded += chunk.length;
  }

  console.log("Deputy rows uploaded:", uploaded);

  return uploaded;
}

// ----------------------
// UPLOAD TT
// ----------------------
async function uploadTT(records) {
  let uploaded = 0;

  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);

    console.log(
      `Uploading TT chunk ${i / CHUNK_SIZE + 1}:`,
      chunk.length,
      "rows"
    );

    const { error } = await supabase
      .from("TT_Games")
      .upsert(chunk, { onConflict: "game_key" });

    if (error) throw new Error(JSON.stringify(error));

    uploaded += chunk.length;
  }

  console.log("TT rows uploaded:", uploaded);

  return uploaded;
}

// ----------------------
// MAIN SYNC
// ----------------------
async function sync() {
  try {
    console.log("📥 Starting sync...");

    await logStart("excel-sync");

    const buffer = await getExcelBuffer();

    // ----------------------
    // DEPUTY
    // ----------------------
    let deputy = parseDeputyData(buffer);
    deputy = dedupe(deputy, "shift_key");

    console.log("DEPUTY ROWS:", deputy.length);

    // ----------------------
    // TT (FIXED)
    // ----------------------
    let tt = parseTTData(buffer);
    tt = dedupe(tt, "game_key");

    console.log("TT ROWS:", tt.length);

    // ----------------------
    // UPLOAD
    // ----------------------
    const deputyUploaded = await uploadToSupabase(deputy);
    const ttUploaded = await uploadTT(tt);

    // Guard against a silent no-op sync. If we parsed rows but wrote
    // none, that is a failure even though no error was thrown.
    if (deputy.length > 0 && deputyUploaded === 0) {
      throw new Error(
        `Parsed ${deputy.length} Deputy rows but uploaded 0 — aborting as failure.`
      );
    }

    if (tt.length > 0 && ttUploaded === 0) {
      throw new Error(
        `Parsed ${tt.length} TT rows but uploaded 0 — aborting as failure.`
      );
    }

    await logSuccess(deputyUploaded + ttUploaded);

    console.log(
      `🎉 Sync complete! Deputy: ${deputyUploaded}, TT: ${ttUploaded}`
    );
  } catch (err) {
    console.error("💥 Sync failed:", err);
    await logFailure(err);
  }
}

sync();