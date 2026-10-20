# Check 562 — Throw-In Mismatch Investigation (READ-ONLY)

## Summary answer (read this first)

**The throw-in mismatch in check 562 is a DATA problem, not a code/offset bug. No code change is recommended.**

The two source feeds coded their throw-ins at genuinely different moments (and in slightly different counts: **25 master vs 27 analyst**). After every offset in the pipeline is applied, the nearest master↔analyst throw-in pairs are scattered from **−167s to +134s** apart with no consistent direction — a random spread, not a fixed lag. Meanwhile every OTHER event type lines up to within **0–1 second** (kickoffs, goals, corners — see the control test below). A single wrong offset would shift ALL stats, or at least all throw-ins by the same amount; here only throw-ins drift, and they drift both ways. That signature is characteristic of human coding differences, not a systematic timing error in code.

Two things in the investigation brief turned out differently from the row's actual contents, and they matter:

1. **Tolerance is 5 seconds**, not 3 (`tolerance = 5` on the row).
2. **Both sides are JSON feeds**, not "XML master vs JSON analyst". `file_name_master = "RD6 Vic Rovers v Vic Country U13 Boys.json"` and `xml_master` begins `{ "allStatistics": [ … ] }`. Because of this, the `−6s` throw-in shift and the `+7s` `codeTime` offset are applied to **both** sides identically and therefore **cancel out** — they cannot be the cause and changing them cannot fix anything (it would move master and analyst by the same amount).

---

## Evidence

### 1. How the data is parsed (code path, verified)

On re-opening a saved check, `app/accuracy-compare/page.tsx` (~line 1749) rebuilds BOTH sides via `loadedFileFromRaw(name, raw)`. That function (same file, ~line 243) detects JSON by filename `.json` or a leading `{` and routes to `loadedFileFromJson`, which calls `jsonEventsToInstances(events, { playerNumberByUid })` (`lib/comparison/json-adapter.ts`). The server-side equivalent `instancesFromRaw` (`lib/api/accuracyChecks.ts`, line 54) does the identical thing. For check 562, **both** `xml_master` and `xml_analyst` start with `{`, so **both go through `jsonEventsToInstances`**.

Consequences, both confirmed against the stored payloads:

- The analyst `relativeTime` is a **whole-match clock that does not reset** per quarter (`q1Start = 11`, `q2Start = 1222`; q1 events run 11→1218, q2 events continue 1222→2422). No `quarterOffsets` are passed and none are needed — the clock is already continuous. So the "quarter offset" concern does not apply here.
- The master payload has `quarter: 0` on every event and already-whole-match `relativeTime` (it is a native-schema export, the shape `instancesToNativeStatEvents` produces). It too is a continuous clock from the same origin.

### 2. The offset pipeline nets to the SAME transform on both sides

For a throw-in (`statTypeCode: "ThrowIn"` → canonical stat `"Throw Ins"`), the adapter does (`json-adapter.ts` ~lines 253–261, 288–292):

- `adjustedStart = max(0, relativeTime − 6)`  ← the throw-in −6s shift
- `mid = codeTime("Throw Ins", adjustedStart, adjustedStart)`

`codeTime` (`xml-compare.ts` lines 207–219) finds the `STAT_START_OFFSETS` keyword `"throw in"` → `+7`, returning `adjustedStart + 7`.

Net: **`mid = relativeTime − 6 + 7 = relativeTime + 1`** — applied identically to master and analyst (both are JSON). The matcher compares `mid` within `tolerance`, and throw-ins are event stats (`isEventStat`), so team/player don't gate the match (`fieldsOk` in `compareInstances`). Therefore the delta the matcher sees is just the **raw `relativeTime` difference**; the −6/+7 offsets contribute **zero** to any master↔analyst mismatch.

### 3. Control test — everything except throw-ins aligns to 0–1s

Nearest-neighbour signed deltas (analyst − master) on events coded at precise moments:

| Stat | Master count | Analyst count | Nearest deltas (s) |
|---|---|---|---|
| Kick Offs | 6 | 5 | 0, −1, 0, 0, −1, 0 |
| Goals | 3 | 3 | 0, 0, 0 |
| Corners | 3 | 3 | +1, −1, 0 |

The first non-marker events also coincide (both feeds have `KickOff` at `relativeTime = 11`). The clocks share an origin and the pipeline is sound. **Only throw-ins drift**, which rules out a global/time-base bug.

### 4. Complete MASTER throw-in timeline (25) — `codeTime` mid = raw + 1

| raw relTime (mm:ss) | after −6s | mid after +7 (mm:ss) | team | player# | stat |
|---|---|---|---|---|---|
| 11 (00:11) | 5 | 12 (00:12) | Rovers | 13 | Throw Ins |
| 138 (02:18) | 132 | 139 (02:19) | Country | 6 | Throw Ins |
| 168 (02:48) | 162 | 169 (02:49) | Country | 6 | Throw Ins |
| 277 (04:37) | 271 | 278 (04:38) | Rovers | 2 | Throw Ins |
| 407 (06:47) | 401 | 408 (06:48) | Rovers | 4 | Throw Ins |
| 428 (07:08) | 422 | 429 (07:09) | Country | 6 | Throw Ins |
| 474 (07:54) | 468 | 475 (07:55) | Rovers | 4 | Throw Ins |
| 488 (08:08) | 482 | 489 (08:09) | Country | 4 | Throw Ins |
| 505 (08:25) | 499 | 506 (08:26) | Country | 6 | Throw Ins |
| 587 (09:47) | 581 | 588 (09:48) | Country | 4 | Throw Ins |
| 610 (10:10) | 604 | 611 (10:11) | Rovers | 2 | Throw Ins |
| 718 (11:58) | 712 | 719 (11:59) | Country | 6 | Throw Ins |
| 802 (13:22) | 796 | 803 (13:23) | Country | 4 | Throw Ins |
| 893 (14:53) | 887 | 894 (14:54) | Rovers | 2 | Throw Ins |
| 990 (16:30) | 984 | 991 (16:31) | Rovers | 2 | Throw Ins |
| 1189 (19:49) | 1183 | 1190 (19:50) | Country | 8 | Throw Ins |
| 1518 (25:18) | 1512 | 1519 (25:19) | Country | 8 | Throw Ins |
| 1527 (25:27) | 1521 | 1528 (25:28) | Rovers | 2 | Throw Ins |
| 1527 (25:27) | 1521 | 1528 (25:28) | Rovers | 2 | Throw Ins |
| 1558 (25:58) | 1552 | 1559 (25:59) | Rovers | 2 | Throw Ins |
| 1559 (25:59) | 1553 | 1560 (26:00) | Rovers | 2 | Throw Ins |
| 1683 (28:03) | 1677 | 1684 (28:04) | Country | 4 | Throw Ins |
| 1711 (28:31) | 1705 | 1712 (28:32) | Country | 8 | Throw Ins |
| 1808 (30:08) | 1802 | 1809 (30:09) | Rovers | 2 | Throw Ins |
| 2149 (35:49) | 2143 | 2150 (35:50) | Rovers | 12 | Throw Ins |

### 5. Complete ANALYST throw-in timeline (27) — `codeTime` mid = raw + 1

| raw relTime (mm:ss) | after −6s | mid after +7 (mm:ss) | team | player# | stat |
|---|---|---|---|---|---|
| 27 (00:27) | 21 | 28 (00:28) | Rovers | 13 | Throw Ins |
| 126 (02:06) | 120 | 127 (02:07) | Rovers | 14 | Throw Ins |
| 141 (02:21) | 135 | 142 (02:22) | Rovers | 14 | Throw Ins |
| 155 (02:35) | 149 | 156 (02:36) | Rovers | 14 | Throw Ins |
| 184 (03:04) | 178 | 185 (03:05) | Rovers | 13 | Throw Ins |
| 312 (05:12) | 306 | 313 (05:13) | Country | 6 | Throw Ins |
| 342 (05:42) | 336 | 343 (05:43) | Country | 6 | Throw Ins |
| 451 (07:31) | 445 | 452 (07:32) | Rovers | 2 | Throw Ins |
| 581 (09:41) | 575 | 582 (09:42) | Rovers | 13 | Throw Ins |
| 602 (10:02) | 596 | 603 (10:03) | Country | 6 | Throw Ins |
| 649 (10:49) | 643 | 650 (10:50) | Rovers | 4 | Throw Ins |
| 662 (11:02) | 656 | 663 (11:03) | Country | 4 | Throw Ins |
| 678 (11:18) | 672 | 679 (11:19) | Country | 6 | Throw Ins |
| 762 (12:42) | 756 | 763 (12:43) | Country | 4 | Throw Ins |
| 785 (13:05) | 779 | 786 (13:06) | Rovers | 2 | Throw Ins |
| 892 (14:52) | 886 | 893 (14:53) | Country | 6 | Throw Ins |
| 976 (16:16) | 970 | 977 (16:17) | Country | 4 | Throw Ins |
| 1067 (17:47) | 1061 | 1068 (17:48) | Rovers | 2 | Throw Ins |
| 1164 (19:24) | 1158 | 1165 (19:25) | Rovers | 2 | Throw Ins |
| 1363 (22:43) | 1357 | 1364 (22:44) | Country | 8 | Throw Ins |
| 1692 (28:12) | 1686 | 1693 (28:13) | Country | 8 | Throw Ins |
| 1701 (28:21) | 1695 | 1702 (28:22) | Rovers | 2 | Throw Ins |
| 1733 (28:53) | 1727 | 1734 (28:54) | Rovers | 2 | Throw Ins |
| 1857 (30:57) | 1851 | 1858 (30:58) | Country | 4 | Throw Ins |
| 1885 (31:25) | 1879 | 1886 (31:26) | Country | 8 | Throw Ins |
| 1982 (33:02) | 1976 | 1983 (33:03) | Rovers | 2 | Throw Ins |
| 2323 (38:43) | 2317 | 2324 (38:44) | Rovers | 12 | Throw Ins |

### 6. Side-by-side alignment (each master → nearest analyst by `mid`, tolerance = 5s)

| # | master mid (mm:ss) | team/# | nearest analyst mid (mm:ss) | team/# | Δ (s) | verdict |
|---|---|---|---|---|---|---|
| 0 | 12 (00:12) | Rovers 13 | 28 (00:28) | Rovers 13 | +16 | MISSED/EXTRA |
| 1 | 139 (02:19) | Country 6 | 142 (02:22) | Rovers 14 | +3 | within tol → match |
| 2 | 169 (02:49) | Country 6 | 156 (02:36) | Rovers 14 | −13 | MISSED/EXTRA |
| 3 | 278 (04:38) | Rovers 2 | 313 (05:13) | Country 6 | +35 | MISSED/EXTRA |
| 4 | 408 (06:48) | Rovers 4 | 452 (07:32) | Rovers 2 | +44 | MISSED/EXTRA |
| 5 | 429 (07:09) | Country 6 | 452 (07:32) | Rovers 2 | +23 | MISSED/EXTRA |
| 6 | 475 (07:55) | Rovers 4 | 452 (07:32) | Rovers 2 | −23 | MISSED/EXTRA |
| 7 | 489 (08:09) | Country 4 | 452 (07:32) | Rovers 2 | −37 | MISSED/EXTRA |
| 8 | 506 (08:26) | Country 6 | 452 (07:32) | Rovers 2 | −54 | MISSED/EXTRA |
| 9 | 588 (09:48) | Country 4 | 582 (09:42) | Rovers 13 | −6 | MISSED/EXTRA |
| 10 | 611 (10:11) | Rovers 2 | 603 (10:03) | Country 6 | −8 | MISSED/EXTRA |
| 11 | 719 (11:59) | Country 6 | 679 (11:19) | Country 6 | −40 | MISSED/EXTRA |
| 12 | 803 (13:23) | Country 4 | 786 (13:06) | Rovers 2 | −17 | MISSED/EXTRA |
| 13 | 894 (14:54) | Rovers 2 | 893 (14:53) | Country 6 | −1 | within tol → match |
| 14 | 991 (16:31) | Rovers 2 | 977 (16:17) | Country 4 | −14 | MISSED/EXTRA |
| 15 | 1190 (19:50) | Country 8 | 1165 (19:25) | Rovers 2 | −25 | MISSED/EXTRA |
| 16 | 1519 (25:19) | Country 8 | 1364 (22:44) | Country 8 | −155 | MISSED/EXTRA |
| 17 | 1528 (25:28) | Rovers 2 | 1364 (22:44) | Country 8 | −164 | MISSED/EXTRA |
| 18 | 1528 (25:28) | Rovers 2 | 1364 (22:44) | Country 8 | −164 | MISSED/EXTRA |
| 19 | 1559 (25:59) | Rovers 2 | 1693 (28:13) | Country 8 | +134 | MISSED/EXTRA |
| 20 | 1560 (26:00) | Rovers 2 | 1693 (28:13) | Country 8 | +133 | MISSED/EXTRA |
| 21 | 1684 (28:04) | Country 4 | 1693 (28:13) | Country 8 | +9 | MISSED/EXTRA |
| 22 | 1712 (28:32) | Country 8 | 1702 (28:22) | Rovers 2 | −10 | MISSED/EXTRA |
| 23 | 1809 (30:09) | Rovers 2 | 1858 (30:58) | Country 4 | +49 | MISSED/EXTRA |
| 24 | 2150 (35:50) | Rovers 12 | 1983 (33:03) | Rovers 2 | −167 | MISSED/EXTRA |

Only **2 of 25** master throw-ins have any analyst within tolerance, and even those two pair with a DIFFERENT team/player (rows 1 and 13), i.e. coincidental time proximity, not the same event. (Because throw-ins are event stats the matcher ignores team/player, so those two would still score as matches — but they are not genuinely the same throw-in.)

Signed-delta statistics across the 25 nearest pairs: **n = 25, mean = −18.1s, median = −10s, min = −167s, max = +134s.** The sign flips repeatedly and the range spans ~300 seconds. There is no constant offset to correct.

---

## Root cause

The analyst and master coders **recorded throw-ins at different match times, different players, and in different counts.** Specific tells in the data:

- **Counts differ:** 25 master vs 27 analyst throw-ins. Players differ too — early on, master attributes throw-ins to Country #6 while analyst attributes a cluster to Rovers #14 (players the other side's throw-ins never reference).
- **Deltas are random in sign and magnitude** (−167s … +134s), unlike the 0–1s agreement on kickoffs/goals/corners. A code offset would be a single constant and would move all throw-ins the same way; this does not.
- **The clocks and pipeline are proven correct** by the control events, so there is nothing in `json-adapter.ts` / `xml-compare.ts` timing to blame for 562.

In short: the offsets (`−6s` shift, `+7s codeTime`) are a red herring for this check because 562 is JSON-vs-JSON, so they apply symmetrically and cancel. The large gaps are real differences in when/by-whom the two coders logged throw-ins.

## Recommendation

**No code change.** This is a data/coding-accuracy issue for check 562, not a bug in the offset pipeline. The large Missed/Extra throw-in counts are the correct output of the matcher given two feeds that genuinely disagree on throw-in timing and attribution. Recommended follow-ups, all non-code:

1. Treat 562's throw-in result as a legitimate low-accuracy finding and review the analyst's throw-in coding against video.
2. If a broader pattern is suspected, re-run this same control-vs-throw-in delta check on other JSON-vs-JSON checks; only if throw-ins there show a *consistent* one-directional offset (and other stats do not) would a code change be justified — and the number would come from that measured median, not a guess.

### Note on the −6s shift (context, not a fix for 562)

The `adjustedStart = max(0, start − 6)` shift (`json-adapter.ts` line 261) and the `+7` throw-in entry in `STAT_START_OFFSETS` (`xml-compare.ts` lines 165–168) exist to align a JSON analyst feed against an **XML** master (the asymmetric case the comment describes). In check 562 both sides are JSON, so the shift is applied twice and cancels — it neither helps nor hurts here. No evidence from 562 supports changing either number; any change would need to be derived from a check where the two sources are of different types and throw-ins show a measurable, consistent residual offset.

---

## What was verified vs not

- **Verified (live data):** Pulled row id = 562 from Supabase REST (`accuracy_checks`, read-only). Confirmed `tolerance = 5`, `sport = football`, both payloads are JSON `allStatistics` feeds, exact throw-in timelines (25 master / 27 analyst), continuous whole-match clocks, and the 0–1s alignment of all control events.
- **Verified (code):** The re-open path parses both sides via `jsonEventsToInstances`; the −6/+7 offsets net to `raw + 1` on both sides; the matcher compares `mid` and treats throw-ins as event stats.
- **Not verified:** The underlying video (not available here), so the determination that the analyst (vs master) is the one coding throw-ins "wrong" is not assigned — only that the two disagree. No write was performed to Supabase; the row was read, not modified.
