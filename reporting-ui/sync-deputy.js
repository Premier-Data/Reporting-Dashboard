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
  // Non-numeric text: keep it only if it's a real time string ("9:30" or
  // "09:30:00"); anything else (e.g. a stray "End" header) can't be a time, and
  // sending it to a Postgres `time` column would reject the whole batch.
  if (isNaN(num)) {
    return /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(value).trim()) ? String(value).trim() : null;
  }

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

// The Deputy sheet is a single rolling sheet (all shifts), so its season CANNOT
// come from a sheet name — it is derived per row from the shift date.
//
// BOUNDARY RULE (must match lib/analytics/season.ts exactly): Week 1 is the
// Wed→Tue week that CONTAINS 1 October, and the season begins at the start of
// that week. So the season rolls on the WEDNESDAY ON-OR-BEFORE 1 October. For
// 2026 that is Wed 30 Sep 2026 (1 Oct 2026 is a Thursday), so 30 Sep 2026 is
// the first day of the 2027 season — matching Week 1 in the sheet. A date
// on/after its calendar year's roll belongs to the NEXT year's season. Returns
// null for an unparseable date (rather than guessing).
//
// WHY a season column matters here: deputy_shifts.week restarts each season, so
// there are two "week 1" rows (one per season) with different dates. Grouping
// by week number alone would merge them; qualifying by (season, week) keeps
// each season's weeks distinct.
const SEASON_WEEK_START_DOW = 3; // Wednesday (0=Sun..6=Sat)

// The Wed on-or-before 1 Oct of `calendarYear` — first day of season (year+1).
function seasonRollDate(calendarYear) {
  const oct1 = new Date(Date.UTC(calendarYear, 9, 1, 0, 0, 0));
  const back = (oct1.getUTCDay() - SEASON_WEEK_START_DOW + 7) % 7;
  return new Date(oct1.getTime() - back * 24 * 60 * 60 * 1000);
}

function deputySeasonFromDate(isoDate) {
  if (!isoDate) return null;
  const d = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  return d >= seasonRollDate(y) ? y + 1 : y;
}

// The week number WITHIN the season for a date, using the same Wed→Tue weeks
// as the rest of reporting. Week 1 is the week containing 1 Oct (starts on the
// Wed on-or-before 1 Oct = the season roll date). Used for sheets that carry a
// Date but NO Week column (SoccerData). Returns null for an unparseable date.
function seasonWeekFromDate(isoDate) {
  if (!isoDate) return null;
  const d = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const season = deputySeasonFromDate(isoDate); // label (e.g. 2027)
  const start = seasonRollDate(season - 1); // first day of that season
  const diffDays = Math.floor((d.getTime() - start.getTime()) / 86400000);
  return Math.floor(diffDays / 7) + 1; // week 1 = first 7-day block
}

// The Deputy sheet is a single rolling sheet (Option A). Exact name, overridable
// via env only if it's ever renamed. Season is NOT taken from this name — it's
// derived per row from the shift date (see deputySeasonFromDate).
const DEPUTY_SHEET_NAME = process.env.DEPUTY_SHEET_NAME || "DeputyRawData";

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

  // The sync reads the SharePoint copy, which can lag a few seconds-minutes
  // behind edits made in Excel. Print when it was last saved so a "my change
  // isn't showing" case is obvious (compare against when you made the edit).
  console.log(
    `🕒 SharePoint copy last saved: ${meta.data.lastModifiedDateTime} ` +
      `(now: ${new Date().toISOString()})`
  );
  console.log("📥 Downloading Excel file...");

  const file = await axios.get(downloadUrl, {
    responseType: "arraybuffer",
  });

  return file.data;
}

// ----------------------
// PARSE DEPUTY
// ----------------------
function parseDeputyData(buffer, sheetName, season) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  // Exact match on the given season's sheet (e.g. "DeputyRawData" for 2026,
  // "2027_DeputyRawData" for 2027). Season comes from the SHEET (the arg), not
  // the date — each season lives in its own sheet.
  const sheet = getSheetExact(workbook, sheetName);
  console.log(`📄 Deputy sheet: "${sheetName}" (season ${season})`);

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  console.log("Deputy Header:", rows[0]);
  console.log("First Deputy Row:", rows[1]);
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

    // Skip rows with no valid shift date. This catches a stray header row
    // pasted mid-sheet (e.g. "Employee Name","Date","Start","End"…), whose
    // text cells ("End") would otherwise reach Postgres and fail the whole
    // sync with "invalid input syntax for type time".
    if (!excelDateToJS(r[2])) {
      skipped++;

      console.log(
        `⚠️ Skipped non-data row (no valid date) in "${sheetName}" sheet row`,
        i + 2,
        JSON.stringify(r)
      );

      return false;
    }

    return true;
  });

  console.log("Skipped rows:", skipped);
  console.log("Rows after filter:", filtered.length);

  return filtered.map(r => {
    const shift_date = excelDateToJS(r[2]);
    return {
      shift_key: `${r[0]}_${r[2]}_${r[3]}_${r[4]}`,

      employee_name: r[0],
      level: String(r[1] || ""),

      shift_date,
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
      // Season comes from the SHEET this row was read from (2026 =
      // DeputyRawData, 2027 = 2027_DeputyRawData), qualifying the restarting
      // week number so the two "week 1"s don't collide.
      season,
      source_file: sheetName,
    };
  });
}

// ----------------------
// PARSE TT
// ----------------------
// Builds the TT_Games game_key. Default (every existing sheet) is the legacy
// `${date}_${home}_${away}`, byte-for-byte unchanged. With `disambiguate`
// (2025 sheet only) a LATER row whose key is already in `used` is made unique
// deterministically: append the cleaned Competition, then Round, then "#2",
// "#3"... The first occurrence (sheet order) keeps the plain legacy key.
// `used` is a per-parse Set; keys stay stable across syncs while the sheet
// order is unchanged.
function makeTTGameKey({ date, home, away, competition, round }, used, disambiguate) {
  const base = `${date}_${home}_${away}`;
  if (!disambiguate) return base;
  let key = base;
  if (used.has(key) && competition) key = `${base}_${competition}`;
  if (used.has(key) && round) key = `${key}_${round}`;
  if (used.has(key)) {
    const start = key;
    let n = 2;
    while (used.has(key)) key = `${start}#${n++}`;
  }
  used.add(key);
  return key;
}

function parseTTData(buffer, sheetName, season, opts = {}) {
  const uniqueKeys = !!opts.uniqueKeys;
  const usedKeys = new Set();
  let suffixedKeys = 0;

  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = getSheetExact(workbook, sheetName);
  console.log(`📄 TT sheet: "${sheetName}" (season ${season})`);

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  console.log("TT Header:", rows[0]);
  console.log("Raw videoURL value:", rows[1][13]);

  let fallbackTT = 0;
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
      const weekFromDate = seasonWeekFromDate(date);
      const seasonFromDate = deputySeasonFromDate(date);
      if (weekFromDate == null) fallbackTT++;
      const away_team = clean(r[4]);

      const competition = clean(r[1]);
      const round = clean(r[2]);
      const game_key = makeTTGameKey(
        { date, home: home_team, away: away_team, competition, round },
        usedKeys,
        uniqueKeys
      );
      if (uniqueKeys && game_key !== `${date}_${home_team}_${away_team}`) suffixedKeys++;

      return {

        game_key,

        Date: date,

        Competition: competition,
        Round: round,

        home_team,
        away_team,

        home_allocated: clean(r[5]),
        away_allocated: clean(r[6]),

        Location: clean(r[7]),
        Additional: clean(r[8]),

        // Season + Week are DERIVED from Date (unified Wed->Tue rule); the
        // sheet Week column (r[9]) is no longer read.
        Week: weekFromDate != null ? String(weekFromDate) : null,

        Column11: clean(r[10]),      // Month

        expected_day: clean(r[11]),  // Completion day

        videoURL: cleanUrl(r[12]),

        // Season for this row — the sheet it was read from (2026 = TTRawData,
        // 2027 = 2027_TTRawData).
        season: seasonFromDate ?? season,

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
  const readTT = rows.slice(1).filter(r => r && r.length).length;
  const removedByDedupe = parsed.length - new Set(parsed.map(p => p.game_key)).size;
  console.log(
    `TT sheet "${sheetName}": rows read ${readTT}, parsed ${parsed.length}, skipped ${skippedTT}, ` +
      `collisions suffixed ${suffixedKeys}, removed by dedupe ${removedByDedupe}`
  );
  if (removedByDedupe > 0) {
    console.log(`⚠️ TT sheet "${sheetName}": ${removedByDedupe} rows share a game_key and will be collapsed by dedupe`);
  }
  if (fallbackTT) console.warn(`TT rows with unusable Date (sheet season kept, Week "0"): ${fallbackTT}`);
  console.log("First Parsed TT Row:", parsed[0]);

  return parsed;
}

// ----------------------
// PARSE SOCCER (SoccerData sheet)
// ----------------------
// Columns: Date | Competition | Round | Home Team | Away Team | Home Allocated |
//          Away Allocated | VideoURL | Location
// No Week column, so season + week are DERIVED from the date (same Wed→Tue
// weeks as the rest of reporting).
// ----------------------
// PARSE COMPLETION TIMES (Completion Times sheet)
// ----------------------
// Maps "Fixture Complete Time" onto soccer games. Columns (0-based):
//   2 = Fixture Date, 4 = Competition, 5 = Round, 6 = Home, 7 = Away,
//   18 = Fixture Complete Time (Excel datetime serial).
// Competition names differ between sheets (SoccerData appends year suffixes),
// so the join is Date+Home+Away, falling back to Home+Away (teams normalised,
// FC/SC stripped). Verified match rate ~77%; unmatched games get no completion
// date and are excluded from "completed each week" on the page.
function normTeam(v) {
  return String(v ?? "")
    .toLowerCase()
    .replace(/\b(fc|sc|afc)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseCompletionTimes(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const found = workbook.SheetNames.find(
    n => n.trim().toLowerCase() === "completion times"
  );
  if (!found) {
    console.log("⚠️ 'Completion Times' sheet not found — soccer completion dates skipped.");
    return { byDateHomeAway: new Map(), byHomeAway: new Map() };
  }
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[found], { header: 1 });

  const byDateHomeAway = new Map(); // "iso|home|away" -> completed_date (iso)
  const byHomeAway = new Map();     // "home|away" -> completed_date (iso) [first seen]
  let withTime = 0;
  for (const r of rows.slice(1)) {
    if (!r || r.length === 0) continue;
    const completeSerial = r[18];
    if (completeSerial == null || completeSerial === "") continue; // no completion time → skip
    const completed = excelDateToJS(completeSerial);
    if (!completed) continue;
    withTime++;
    const h = normTeam(r[6]);
    const a = normTeam(r[7]);
    const d = excelDateToJS(r[2]);
    if (d) byDateHomeAway.set(`${d}|${h}|${a}`, completed);
    const hk = `${h}|${a}`;
    if (!byHomeAway.has(hk)) byHomeAway.set(hk, completed);
  }
  console.log(`📄 Completion Times: ${rows.length - 1} rows, ${withTime} with a Fixture Complete Time`);
  return { byDateHomeAway, byHomeAway };
}

// Resolve a soccer game's completion date from the lookup maps (Date+Home+Away
// first, then Home+Away). Returns null when there's no match.
function completionDateFor(completion, date, home, away) {
  const h = normTeam(home);
  const a = normTeam(away);
  const exact = completion.byDateHomeAway.get(`${date}|${h}|${a}`);
  if (exact) return exact;
  return completion.byHomeAway.get(`${h}|${a}`) ?? null;
}

// Builds a unique, deterministic game_key for a SoccerData row.
// The key includes Competition and Round so that double round-robin
// tournaments (same two teams meeting twice on one date in different rounds)
// are not collapsed into one row. `seen` is a per-parse Map used to number
// truly identical rows in sheet order: the 1st occurrence has no suffix, the
// 2nd gets "#2", the 3rd "#3"... so keys stay stable across syncs as long as
// the sheet order of those identical rows is unchanged.
function makeSoccerGameKey({ date, competition, round, home, away }, seen) {
  const base = [date, competition ?? "-", round ?? "-", home, away].join("_");
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  return n === 1 ? base : `${base}#${n}`;
}

function parseSoccerData(buffer, completion) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = getSheetExact(workbook, "SoccerData");
  console.log(`📄 Soccer sheet: "SoccerData"`);

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  console.log("Soccer Header:", rows[0]);

  const clean = v => {
    if (v == null) return null;
    const s = String(v).replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
    return s === "" ? null : s;
  };
  const cleanUrl = v => {
    const s = clean(v);
    return s == null ? null : s.replace(/ /g, "%20");
  };

  let skipped = 0;
  let matched = 0;
  const skippedExamples = [];
  const seenKeys = new Map();
  const dataRows = rows.slice(1).filter(r => r && r.length);
  const parsed = dataRows
    .map((r, idx) => {
      const date = excelDateToJS(r[0]);
      const home_team = clean(r[3]);
      const away_team = clean(r[4]);
      const competition = clean(r[1]);
      const round = r[2] == null || r[2] === "" ? null : String(r[2]);
      // Sheet row number (1-based, header is row 1) is approximate if blank
      // rows were filtered out above; good enough to locate the problem.
      const sheetRow = idx + 2;
      const valid = date && home_team && away_team;
      if (!valid) {
        skipped++;
        if (skippedExamples.length < 10) {
          skippedExamples.push(
            `row ${sheetRow}: date=${date} home=${home_team} away=${away_team}`
          );
        }
        return null;
      }
      // Completion date (when the fixture was actually finished), from the
      // Completion Times sheet. Null when unmatched → excluded from the
      // "completed each week" view. season/week are DERIVED from this date,
      // since "games completed each week" is bucketed by completion, not
      // fixture date.
      const completed_date = completion
        ? completionDateFor(completion, date, home_team, away_team)
        : null;
      if (completed_date) matched++;
      return {
        game_key: makeSoccerGameKey(
          { date, competition, round, home: home_team, away: away_team },
          seenKeys
        ),
        Date: date,
        Competition: competition,
        Round: round,
        home_team,
        away_team,
        home_allocated: clean(r[5]),
        away_allocated: clean(r[6]),
        videoURL: cleanUrl(r[7]),
        Location: clean(r[8]),
        // Fixture-date season/week (kept for reference / fallback views).
        season: deputySeasonFromDate(date),
        week: seasonWeekFromDate(date),
        // Completion date + its season/week (null when no completion time).
        completed_date,
        completed_season: completed_date ? deputySeasonFromDate(completed_date) : null,
        completed_week: completed_date ? seasonWeekFromDate(completed_date) : null,
      };
    })
    .filter(Boolean);

  console.log(`Soccer sheet rows read: ${dataRows.length}, parsed: ${parsed.length}`);
  console.log("Skipped malformed Soccer rows (missing Date/Home/Away):", skipped);
  skippedExamples.forEach(e => console.log("  skipped", e));
  console.log(`Soccer games with a completion date: ${matched} / ${parsed.length}`);
  console.log("First Parsed Soccer Row:", parsed[0]);
  return parsed;
}

// ----------------------
// PARSE VN TEAM (VNTeam sheet)
// ----------------------
// Columns: Name | <weekly wage>.  Header's 2nd cell is the total weekly pool
// (e.g. 4412); each row is one member's fixed WEEKLY wage (e.g. 490.22).
function parseVNTeam(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = getSheetExact(workbook, "VNTeam");
  console.log(`📄 VN Team sheet: "VNTeam"`);

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const clean = v => {
    if (v == null) return null;
    const s = String(v).replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
    return s === "" ? null : s;
  };

  const parsed = rows
    .slice(1)
    .filter(r => r && r[0] != null && String(r[0]).trim() !== "")
    .map(r => ({
      name: clean(r[0]),
      weekly_wage: Number(r[1]) || 0,
    }))
    .filter(r => r.name);

  console.log("VN Team members:", parsed.length);
  console.log("First VN member:", parsed[0]);
  return parsed;
}

// ----------------------
// PARSE OS TEAM ("OS Team" sheet)
// ----------------------
// Offshore team costs. The sheet holds two stacked blocks (Philippines, then
// Vietnam), each with its own repeated header row:
//   Employee Name | Monthly Cost (AUD) | Weekly Cost (AUD) | Location
// Philippines also has a "Bank Fee" row (monthly, no location) under its
// Gross Total. "Gross Total" / "Total Monthly" rows are ignored — totals are
// computed in the report.
//
// START RULES: a location's cost only counts from a given season + week
// onward (everything earlier is zero). Edit here to change when a team starts.
//   Philippines → from Week 2 of the 2026 season
//   Vietnam     → from Week 17 of the 2026 season
// A location not listed here has no start limit (counts in every week).
// Dates equal legacy W2 / W17 of the old sheet scheme; season/week are derived.
const OS_START = {
  Philippines: { date: "2026-04-01" },
  Vietnam: { date: "2026-07-15" },
};

function parseOSTeam(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const found = workbook.SheetNames.find(
    n => n.trim().toLowerCase().replace(/\s+/g, "") === "osteam"
  );
  if (!found) {
    console.log("⚠️ 'OS Team' sheet not found — OS team costs skipped.");
    return [];
  }
  console.log(`📄 OS Team sheet: "${found}"`);

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[found], { header: 1 });
  const clean = v => {
    if (v == null) return null;
    const s = String(v).replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
    return s === "" ? null : s;
  };

  const out = [];
  let currentLocation = null;

  for (const r of rows) {
    if (!r) continue;
    const name = clean(r[0]);
    if (!name) continue;
    if (/^employee name$/i.test(name)) continue; // repeated header row

    const monthly = r[1] == null ? NaN : Number(r[1]);
    const location = clean(r[3]);

    if (location) {
      // Member row.
      if (!Number.isFinite(monthly)) continue;
      currentLocation = location;
      const weeklyCell = r[2] == null ? NaN : Number(r[2]);
      out.push({
        name,
        location,
        kind: "member",
        monthly_cost: monthly,
        // Prefer the sheet's own weekly figure; otherwise monthly × 12 / 52
        // (the conversion the sheet itself uses).
        weekly_cost: Number.isFinite(weeklyCell) ? weeklyCell : (monthly * 12) / 52,
      });
    } else if (/^bank fee$/i.test(name) && currentLocation && Number.isFinite(monthly)) {
      // Fee row sits inside the block it belongs to (no Location cell).
      out.push({
        name: "Bank Fee",
        location: currentLocation,
        kind: "fee",
        monthly_cost: monthly,
        weekly_cost: (monthly * 12) / 52,
      });
    }
    // Anything else (Gross Total, Total Monthly, …) is ignored.
  }

  // Attach the start season/week for each location.
  const rowsOut = out.map(r => {
    const start = OS_START[r.location];
    return {
      ...r,
      start_date: start ? start.date : null,
      start_season: start ? deputySeasonFromDate(start.date) : null,
      start_week: start ? seasonWeekFromDate(start.date) : null,
    };
  });

  const byLoc = {};
  for (const r of rowsOut) {
    byLoc[r.location] = byLoc[r.location] || { n: 0, weekly: 0 };
    byLoc[r.location].n += 1;
    byLoc[r.location].weekly += r.weekly_cost;
  }
  for (const [loc, v] of Object.entries(byLoc)) {
    console.log(`OS Team ${loc}: ${v.n} rows, weekly cost ${v.weekly.toFixed(2)}`);
  }
  return rowsOut;
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

  // ── Orphan purge ──
  // The sheets are the source of truth. Upsert never removes rows that were
  // edited/deleted in a sheet (e.g. a stale shift with a different
  // start/end time, or a null-season leftover from an old sync), so delete any
  // deputy_shifts whose shift_key is NOT in the current combined sync set.
  // Guarded: never purge when the parse produced zero rows.
  if (records.length > 0) {
    const keep = new Set(records.map((r) => r.shift_key));
    let existing = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("deputy_shifts")
        .select("shift_key")
        .range(from, from + 999);
      if (error) throw new Error(JSON.stringify(error));
      if (!data || data.length === 0) break;
      existing.push(...data.map((d) => d.shift_key));
      if (data.length < 1000) break;
      from += 1000;
    }
    const orphans = existing.filter((k) => !keep.has(k));
    if (orphans.length > 0) {
      for (let i = 0; i < orphans.length; i += CHUNK_SIZE) {
        const chunk = orphans.slice(i, i + CHUNK_SIZE);
        const { error } = await supabase
          .from("deputy_shifts")
          .delete()
          .in("shift_key", chunk);
        if (error) throw new Error(JSON.stringify(error));
      }
      console.log(`Deputy orphans purged: ${orphans.length}`);
    } else {
      console.log("Deputy orphans purged: 0");
    }
  }

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
// UPLOAD SOCCER
// ----------------------
async function uploadSoccer(records) {
  let uploaded = 0;
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);
    console.log(`Uploading Soccer chunk ${i / CHUNK_SIZE + 1}:`, chunk.length, "rows");
    const { error } = await supabase
      .from("soccer_games")
      .upsert(chunk, { onConflict: "game_key" });
    if (error) throw new Error(JSON.stringify(error));
    uploaded += chunk.length;
  }
  console.log("Soccer rows uploaded:", uploaded);

  // ── Orphan purge ──
  // The sheet is the source of truth. Upsert alone never removes rows that
  // were edited/deleted in the sheet, leaving stale "orphans" that inflate the
  // DB total (and could show in weekly views). Delete any soccer_games whose
  // game_key is NOT in the current sync set. Guarded: never purge when the
  // parse produced zero rows (that would wipe the table on a transient read
  // failure).
  if (records.length > 0) {
    const keep = new Set(records.map((r) => r.game_key));
    let existing = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("soccer_games")
        .select("game_key")
        .range(from, from + 999);
      if (error) throw new Error(JSON.stringify(error));
      if (!data || data.length === 0) break;
      existing.push(...data.map((d) => d.game_key));
      if (data.length < 1000) break;
      from += 1000;
    }
    const orphans = existing.filter((k) => !keep.has(k));
    if (orphans.length > 0) {
      for (let i = 0; i < orphans.length; i += CHUNK_SIZE) {
        const chunk = orphans.slice(i, i + CHUNK_SIZE);
        const { error } = await supabase
          .from("soccer_games")
          .delete()
          .in("game_key", chunk);
        if (error) throw new Error(JSON.stringify(error));
      }
      console.log(`Soccer orphans purged: ${orphans.length}`);
    } else {
      console.log("Soccer orphans purged: 0");
    }
  }

  return uploaded;
}

// ----------------------
// UPLOAD OS TEAM
// ----------------------
// Small table, keyed (name, location). Upsert, then purge rows no longer in the
// sheet. Guarded: never purge when the parse produced nothing.
async function uploadOSTeam(records) {
  if (records.length === 0) return 0;

  let { error } = await supabase
    .from("os_team")
    .upsert(records, { onConflict: "name,location" });
  // start_date is added by migration 009. Until it has run, retry without it
  // so the code can deploy ahead of the migration.
  if (error && /start_date/.test(JSON.stringify(error))) {
    console.log("⚠️ os_team.start_date missing (run migration 009); upserting without it");
    const legacy = records.map(({ start_date, ...rest }) => rest);
    ({ error } = await supabase
      .from("os_team")
      .upsert(legacy, { onConflict: "name,location" }));
  }
  if (error) throw new Error(JSON.stringify(error));

  const keep = new Set(records.map(r => `${r.name}|${r.location}`));
  const { data: existing, error: readErr } = await supabase
    .from("os_team")
    .select("name,location");
  if (readErr) throw new Error(JSON.stringify(readErr));

  let purged = 0;
  for (const row of existing ?? []) {
    if (keep.has(`${row.name}|${row.location}`)) continue;
    const { error: delErr } = await supabase
      .from("os_team")
      .delete()
      .eq("name", row.name)
      .eq("location", row.location);
    if (delErr) throw new Error(JSON.stringify(delErr));
    purged += 1;
  }

  console.log(`OS Team rows uploaded: ${records.length} (orphans purged: ${purged})`);
  return records.length;
}

// ----------------------
// UPLOAD VN TEAM
// ----------------------
async function uploadVNTeam(records) {
  if (records.length === 0) return 0;
  const { error } = await supabase
    .from("vn_team")
    .upsert(records, { onConflict: "name" });
  if (error) throw new Error(JSON.stringify(error));
  console.log("VN Team rows uploaded:", records.length);
  return records.length;
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
    // SEASON → SHEET PAIRS
    // ----------------------
    // Each season has its OWN Deputy + TT sheets. Season is stamped from the
    // sheet (not the date). To add a new season, append a pair here. `deputy`
    // / `tt` may be null when a season has no such sheet (2025 is TT-only: its
    // Deputy data comes from the Deputy API). `uniqueKeys` makes colliding
    // game_keys unique (2025 sheet only; see makeTTGameKey).
    const SEASON_SHEETS = [
      { season: 2025, deputy: null, tt: "2025_TTRawData", uniqueKeys: true },
      { season: 2026, deputy: "DeputyRawData", tt: "TTRawData" },
      { season: 2027, deputy: "2027_DeputyRawData", tt: "2027_TTRawData" },
    ];

    // ----------------------
    // DEPUTY (all seasons)
    // ----------------------
    let deputy = [];
    for (const { season, deputy: sheet } of SEASON_SHEETS) {
      if (!sheet) continue;
      try {
        deputy = deputy.concat(parseDeputyData(buffer, sheet, season));
      } catch (e) {
        console.log(`⚠️ Deputy sheet "${sheet}" skipped: ${e.message}`);
      }
    }
    deputy = dedupe(deputy, "shift_key");
    console.log("DEPUTY ROWS:", deputy.length);

    // ----------------------
    // TT (all seasons)
    // ----------------------
    let tt = [];
    for (const { season, tt: sheet, uniqueKeys } of SEASON_SHEETS) {
      if (!sheet) continue;
      try {
        tt = tt.concat(parseTTData(buffer, sheet, season, { uniqueKeys }));
      } catch (e) {
        console.log(`⚠️ TT sheet "${sheet}" skipped: ${e.message}`);
      }
    }
    tt = dedupe(tt, "game_key");
    console.log("TT ROWS:", tt.length);

    // ----------------------
    // SOCCER + VN TEAM
    // ----------------------
    const completion = parseCompletionTimes(buffer);
    let soccer = parseSoccerData(buffer, completion);
    // Safety net: keys are unique per row now, so this should remove 0.
    const soccerParsed = soccer.length;
    soccer = dedupe(soccer, "game_key");
    console.log(
      `SOCCER ROWS: ${soccer.length} (parsed ${soccerParsed}, removed by dedupe: ${soccerParsed - soccer.length})`
    );
    if (soccerParsed !== soccer.length) {
      console.log("⚠️ Soccer dedupe removed rows — game_key is not unique per fixture!");
    }

    const osTeam = parseOSTeam(buffer);
    console.log("OS TEAM ROWS:", osTeam.length);

    const vnTeam = parseVNTeam(buffer);
    console.log("VN TEAM ROWS:", vnTeam.length);

    // ----------------------
    // UPLOAD
    // ----------------------
    const deputyUploaded = await uploadToSupabase(deputy);
    const ttUploaded = await uploadTT(tt);
    const soccerUploaded = await uploadSoccer(soccer);
    const vnUploaded = await uploadVNTeam(vnTeam);

    // OS team is a newer, optional table. If it hasn't been created yet, warn
    // clearly instead of failing the whole sync (Deputy/TT/Soccer above have
    // already uploaded fine).
    let osUploaded = 0;
    try {
      osUploaded = await uploadOSTeam(osTeam);
    } catch (e) {
      console.log(
        `⚠️ OS Team upload skipped: ${e.message}\n` +
          "   (Has the os_team table been created? See migrations/create_os_team.sql)"
      );
    }

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

    if (soccer.length > 0 && soccerUploaded === 0) {
      throw new Error(
        `Parsed ${soccer.length} Soccer rows but uploaded 0 — aborting as failure.`
      );
    }

    await logSuccess(deputyUploaded + ttUploaded + soccerUploaded + vnUploaded);

    console.log(
      `🎉 Sync complete! Deputy: ${deputyUploaded}, TT: ${ttUploaded}, Soccer: ${soccerUploaded}, VN: ${vnUploaded}, OS: ${osUploaded}`
    );
  } catch (err) {
    console.error("💥 Sync failed:", err);
    await logFailure(err);
  }
}

// Only run the sync when executed directly (`node sync-deputy.js`), so the
// parsers can be required for read-only checks/tests.
if (require.main === module) {
  sync();
} else {
  module.exports = { deputySeasonFromDate, seasonWeekFromDate, getExcelBuffer, parseSoccerData, parseTTData, makeTTGameKey, makeSoccerGameKey, parseCompletionTimes };
}