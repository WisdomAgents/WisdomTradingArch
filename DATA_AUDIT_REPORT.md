# WTA-1 Trading System — Data Layer Audit Report

**Prepared:** 2026-04-19  
**Auditor:** Claude Sonnet 4.6 (read-only, no source files modified)  
**File audited:** `src/WTA1.jsx` (4,663 lines as read; project brief states ~2,571 lines — file has grown)  
**Related files read:** `src/create_evaluations_table.sql`, `src/add_precision_validation_columns.sql`, `src/WTA1_Project_Brief.md`, `src/WTA1_Bug_Log.md`

---

## Executive Summary

Six audit items were investigated. Key findings:

1. **Field save vs display:** Most fields are correctly saved as human-readable labels. Three fields carry meaningful save-vs-display discrepancies: `session`, `htf_bias`, and `outcome` use raw keys in the `EMPTY` state but are translated to labels at insert time correctly. `liquidity` is saved as a comma-joined label string. `model` is saved as a label. No catastrophic label/key inversions found in the main `addToJournal` path. However, the **Evaluate tab lacks a `direction` form field** entirely — `direction` in the `EMPTY` state is always `""` and the only write path derives it from `htfBias`, which is a blunt approximation.

2. **Direction and Model fields:** `direction` has no input control in the Evaluate tab — it is derived at save-time from `htfBias`. The `model` field saves correctly from `setupType`. No raw keys persist to Supabase for either field. However, the journal card renders `t.direction` directly (line 2610) and since direction is derived (not entered), the display value depends entirely on the derivation logic at save time.

3. **Invalid Date bug:** The fix (`+ 'T00:00:00'`) **is applied** at line 2613. This issue is resolved in the current code.

4. **Raw liquidity keys:** The Evaluate tab saves liquidity as a label string via a translation map (lines 4542–4556). The journal card detail view also translates keys to labels (lines 2679–2686). However, the journal card detail view's translation map is **incomplete** — it is missing `hopw` and `smc_trap` and `london_h` / `london_l` mappings, causing those keys to fall through to raw key display.

5. **NO TRADE evaluations:** An `insertEvaluation` function exists at lines 860–895 and correctly writes to the `evaluations` table when the pipeline decision is `NO_TRADE`. The function is only triggered manually by the user pressing the "Log No Trade Evaluation" button. If the user closes without pressing the button, the evaluation is lost. Additionally, several fields written to `evaluations` reference columns (`direction`, `model`, `setup_type`, `reason`, `evaluated_at`) that are **not defined** in `create_evaluations_table.sql`.

6. **Schema vs course taxonomy:** Of the 10 taxonomy categories, **none are fully implemented** as structured, queryable columns in the `trades` table. Several are embedded inside the `pipeline` JSONB blob. The trades table insert payload has approximately 17 top-level columns plus the pipeline blob. The taxonomy gap is severe for AI training purposes.

**Overall severity:** The system is functional for personal journalling but the data layer has critical gaps for AI training use. The most pressing issues are: (a) missing structured taxonomy columns, (b) the `evaluations` table column mismatch, (c) liquidity key fall-through in the journal card detail view.

---

## Section 1 — Field Save vs Display Mismatch

### 1.1 What the Insert Payload Contains

The primary insert path is `addToJournal` (lines 4471–4598). Every field written to `supabase.from('trades').insert()` is listed below with its transformation.

| DB Column | Form State Key | Raw Value in State | Value Sent to Supabase | Render on Journal Card |
|---|---|---|---|---|
| `pair` | `inp.pair` | String e.g. `"EURUSD"` | Same string | `t.pair` — direct |
| `setup` | `inp.setupType` | Raw key e.g. `"reversal_bull"` | Translated to `"Bullish Reversal"` via map (line 4526–4529) | `modelLabel[t.setupType]` — uses a separate label map (line 2422). Since `t.setupType` is reconstructed from `t.setup` in `normaliseTrade` (line 55), the card reads the label string back from `setup` and assigns it to both `setup` and `setupType`. Works. |
| `session` | `inp.session` | Raw key e.g. `"london"` | Translated to label e.g. `"London"` via map (lines 4532–4535) | `t.session` — direct. Since the saved value is the label, this renders correctly. |
| `htf_bias` | `inp.htfBias` | Raw key e.g. `"bullish"` | Translated to `"Bullish"` via map (lines 4536–4539) | `t.htfBias` — direct. Label. Correct. |
| `direction` | `trade.direction` | Not a form field in Evaluate tab — derived from `htfBias` at save time (lines 4478–4480) | `"SHORT"` or `"LONG"` or `""` | `t.direction` — direct (line 2610). See Section 2. |
| `poi` | `inp.poiLocation` | Free text string | Same string | `t.poiLocation` — direct. Correct. |
| `liquidity` | `inp.liquidityType` | Array of raw keys e.g. `["eq_high","frankfurt_h"]` | Translated to comma-joined label string e.g. `"Equal Highs, Frankfurt High ✦"` (lines 4542–4556) | In card header: `t.session` area — not shown directly. In card detail section (line 2679–2686): re-translated from `t.liquidityType` which is the array restored from `pipeline.inp.liquidityType`. The `liquidity` column is only used as fallback. **See Section 4 for detail view gap.** |
| `model` | `inp.setupType` (or `trade.model`) | Raw key or label | Translated to label via map (lines 4557–4566) | `t.model` — direct. Label. Correct. |
| `grade` | `ev.grade` | `"A+"`, `"A"`, `"B"`, `"REJECTED"` | Same string | `t.grade` — direct. Correct. |
| `outcome` | `saveForm.outcome` | Raw key e.g. `"win"`, `"loss"`, `"be"`, `"valid_not_taken"` | Translated via `OUTCOME_LABELS` (line 4568). `"win"→"Win"`, `"loss"→"Loss"`, `"be"→"Break Even"`, `"valid_not_taken"→"Valid -- Not Taken"` | `t.outcome` — used in ternary comparisons as `==="win"`. **MISMATCH:** saved value is `"Win"` (capitalised) but comparison checks `==="win"` (lowercase). This will cause W/L/BE display and filtering to fail for all records loaded from Supabase. |
| `r_achieved` | `saveForm.rAchieved` | String (user input) | `parseFloat(...)` or `0` (line 4569) | `t.rAchieved` — used as `parseFloat(t.rAchieved)`. Works. |
| `notes` | `saveForm.notes` | String | Same string | `t.notes` — direct. Correct. |
| `pipeline` | `pipelineSnapshot + inp fields` | Object | Serialised JSONB blob (lines 4493–4521) | Deserialised in `normaliseTrade` and restored to separate fields. Correct architecture. |
| `screenshots` | `saveForm.images` | Array of base64 strings | Compressed base64 array (line 4476) | `t.screenshots` — rendered as `<img src={img}/>`. Correct. |
| `trade_date` | Derived from `backtestDate` or `new Date()` | ISO date string | `YYYY-MM-DD` string (lines 4483–4489) | `t.date` (aliased from `trade_date` in `normaliseTrade` line 67). Parsed with `+ 'T00:00:00'` fix. Correct. |
| `rifc_pip_size` | `inp.rifcPipSize` | String (numeric input) | `parseFloat(...)` or `null` | Not rendered on card. Stored only. |
| `rifc_timeframe` | `inp.rifcTimeframe` | Raw key `"M1"`, `"M2"`, etc. | Translated via `RIFC_TF_LABELS` (line 4577). Keys and labels are identical (`"M1"→"M1"`). No change. | Not rendered on card. |
| `eql_sweep_distance` | `inp.eqlSweepDistance` | String (numeric input) | `parseFloat(...)` or `null` | Not rendered. |
| `eqh_sweep_distance` | `inp.eqhSweepDistance` | String (numeric input) | `parseFloat(...)` or `null` | Not rendered. |
| `opposing_zone_status` | `inp.opposingZoneStatus` | Raw key `"fresh"` or `"spent"` | Translated via `OPPOSING_ZONE_LABELS` (line 4582–4584): `"fresh"→"Fresh"`, `"spent"→"Spent"` | Not rendered on card. |
| `dxy_structure_detail` | `inp.dxyStructureDetail` | Free text | Same string | Not rendered on card. |
| `why_not_taken` | `saveForm.whyNotTaken` | Free text | Same string (line 4586–4588) | Not rendered on card. |

### 1.2 Critical Mismatch: `outcome` case comparison

**Finding:** `addToJournal` saves `outcome` as a capitalised label (`"Win"`, `"Loss"`, `"Break Even"`, `"Valid -- Not Taken"`) via `OUTCOME_LABELS` at line 4568. However, all comparisons in the rendering layer use lowercase: `t.outcome==="win"` (line 2586), `t.outcome==="loss"` (line 2586), `t.outcome==="be"` (line 2783). The filter buttons also filter on `t.outcome===filter` where filters are `"win"`, `"loss"`, `"be"` (line 2563).

**Result:** All trades loaded from Supabase will fail the outcome comparison — they will render as "BE" (the fallback) regardless of actual outcome, win rate will calculate as 0%, and journal filter buttons will return no results for Wins or Losses.

**Severity: Critical**  
**Root cause:** `OUTCOME_LABELS` translates keys to labels at insert time, but `normaliseTrade` and all rendering code still compare against the original lowercase keys. The transformation was added for human-readable storage but the comparisons were never updated to match.  
**Recommended fix direction:** Either (a) store lowercase keys and add a display translation in the render layer, or (b) update all comparison strings to match the capitalised saved labels (`==="Win"`, `==="Loss"`, `==="Break Even"`).

---

## Section 2 — Direction and Model Field Bugs

### 2.1 `direction` Field

**Finding:** The `EMPTY` state at line 124 defines `direction` as not a key at all — there is no `direction` field in the Evaluate tab's `EMPTY` state. The `BL_EMPTY` for the Backtest Log tab (line 3007) does have `direction: ''`.

In `addToJournal` (lines 4477–4480):
```
const direction = trade.direction ||
  (trade.htfBias === 'bearish' ? 'SHORT' :
   trade.htfBias === 'bullish' ? 'LONG' : '');
```

There is no form input for `direction` anywhere in the Evaluate tab. The `EMPTY` state does not define a `direction` field. When `addToJournal` receives the `inp` object, `trade.direction` will be `undefined`, so the fallback to `htfBias` fires every time. The value saved will be `"SHORT"` for bearish bias or `"LONG"` for bullish bias.

The journal card renders `t.direction` directly at line 2610 in the sub-header. Since `normaliseTrade` maps `t.direction` directly from the stored column (line 59), and the stored value is the derived label, the card will show `"SHORT"` or `"LONG"` — which is a label, not a raw key.

**Summary:** `direction` is not broken in the sense that it saves garbage — it saves a derived value. But the value is a blunt approximation of direction (it ignores setup type; a bearish reversal trade in bearish bias may actually be a long). For short bias continuation setups the direction is correct; for reversal setups trading against the HTF bias it is wrong. The field should be derived from `setupType` not `htfBias`.

**Severity: High**  
**Root cause:** No direction input field exists in the Evaluate tab. The fallback derivation conflates HTF bias with trade direction, which is incorrect for reversal models where you trade against the prior bias.  
**Recommended fix direction:** Add a direction toggle (Long / Short) to the Evaluate tab's Setup Classification panel, and include `direction` in `EMPTY`. Remove the fallback derivation from `addToJournal` or limit it to the case where `direction` is genuinely absent.

### 2.2 `model` Field

**Finding:** `model` is correctly computed and saved. In `addToJournal` (lines 4557–4566):
```
model: (() => {
  const raw = trade.model || trade.setupType || trade.selectedModel || trade.setup || '';
  const modelLabels = {
    reversal_bull: 'Bullish Reversal',
    reversal_bear: 'Bearish Reversal',
    cont_bull:     'Bullish Continuation',
    cont_bear:     'Bearish Continuation',
  };
  return modelLabels[raw] || raw;
})(),
```

`trade.setupType` is always populated from `inp.setupType` which is set via the Setup Type dropdown at line 929–930. The translation map covers all four model types. If the raw key is not in the map (e.g. for Live Mode which passes strings like `"reversal_bear"`), the fallback returns `raw` which is already a key — this means for Live Mode saves, the raw key would be stored rather than the label.

**Live Mode path specifics:** The `onSaveToJournal` callback at line 2357 passes `setupType: poiDir==="bearish" ? "reversal_bear" : "reversal_bull"` — the raw key. The `addToJournal` function then translates this correctly via `modelLabels[raw]`. So Live Mode saves correctly.

**model** field status: **No bug. Saves as human-readable label correctly.**

**Severity: None for model field.**

---

## Section 3 — Invalid Date Bug on Journal Cards

**Finding:** The proposed fix (`append T00:00:00`) **is already applied** in the current code.

At line 2612–2616:
```jsx
{t.date
  ? new Date(t.date + 'T00:00:00').toLocaleDateString()
  : t.savedAt
    ? new Date(t.savedAt).toLocaleDateString()
    : '—'}
```

`t.date` is mapped from `t.trade_date` by `normaliseTrade` at line 67. The `trade_date` column stores a `YYYY-MM-DD` string. Without the `T00:00:00` suffix, `new Date("2026-04-19")` is parsed as UTC midnight, which in negative UTC offset timezones renders as the previous day. The fix correctly appends the suffix to force local midnight parsing.

**Status: Resolved in current code.**  
**Severity: N/A (already fixed).**

---

## Section 4 — Raw Liquidity Keys Rendering

### 4.1 Save path

The `addToJournal` function correctly translates `liquidityType` keys to labels at line 4542–4556. The `liquidity` column in Supabase stores a human-readable comma-joined string like `"Equal Highs, Frankfurt High ✦"`. Labels, not raw keys.

Additionally, all granular `inp` fields including `liquidityType` (the array of raw keys) are stored inside the `pipeline` JSONB blob at line 4502. On load, `normaliseTrade` restores `liquidityType` from `pipeline.inp.liquidityType` at line 82–83.

### 4.2 Journal card header row

The journal card header at lines 2586–2603 does not display `liquidity` directly. The sub-header (lines 2607–2617) shows pair, htfBias, direction, trapClarity, and date — not liquidity.

### 4.3 Journal card detail view — GAP FOUND

The "Full Trade Details" expand section at lines 2677–2687 renders liquidity with an inline translation map:

```jsx
{Array.isArray(t.liquidityType)&&t.liquidityType.length>0?t.liquidityType.map(k=>({
  eq_high:'Equal Highs', eq_low:'Equal Lows',
  sess_high:'Session High', sess_low:'Session Low',
  hopd:'Prev Day High', lopd:'Prev Day Low',
  frankfurt_h:'Frankfurt High', frankfurt_l:'Frankfurt Low',
  swing_hl:'Swing Highs and Lows', trendline:'Trendline Liquidity',
  internal:'Internal Liquidity', smc_trap:'SMC Trap Zone',
}[k]||k)).join(", "):"—"}
```

**Missing keys in this inline map:**
- `hopw` — used in the form options (line 1027) but has no entry in the detail view map. Falls through to raw key `"hopw"`.
- `london_h` — present in the form options as `"London Open High ✦"`, absent from the detail view map. Falls through to `"london_h"`.
- `london_l` — same: absent, falls through.

The three missing keys will render as raw keys on the journal card detail view when those liquidity types are selected in the Evaluate tab.

The form `CompactMultiSel` options at line 1027 include: `eq_high, eq_low, sess_high, sess_low, hopd, hopw, trendline, internal, swing_hl, frankfurt_h, frankfurt_l, london_h, london_l, smc_trap, unclear`. The detail view map covers: `eq_high, eq_low, sess_high, sess_low, hopd, lopd, frankfurt_h, frankfurt_l, swing_hl, trendline, internal, smc_trap`. **Missing: `hopw`, `london_h`, `london_l`. Extra/wrong: `lopd` (not in form options).**

**Severity: Medium**  
**Root cause:** The detail view translation map was written independently of the `CompactMultiSel` options and was not kept in sync. Three keys are missing and one non-existent key (`lopd`) is included.  
**Recommended fix direction:** Derive the label map from a single shared constant (e.g. the existing options array at line 1027) rather than duplicating it inline in the render.

---

## Section 5 — NO TRADE Evaluations

### 5.1 Where the NO TRADE decision is made

The pipeline runner `runPipeline` (lines 280–323) produces `decision="NO_TRADE"` when any pipeline stage fails. This is computed in the `EvaluateTab` via `useMemo` at line 467.

### 5.2 What happens to the evaluation data

When `ev.decision === "NO_TRADE"`, the Evaluate tab renders a "Log No Trade Evaluation" button at lines 1351–1370. This is a **manual, opt-in** action. If the user closes the tab, resets the form, or simply does not click the button, all evaluation data is discarded — it exists only in React state.

The `insertEvaluation` function at lines 860–895 executes only when the button is clicked (`onClick={insertEvaluation}`).

### 5.3 Fields written to evaluations table

`insertEvaluation` inserts the following fields:

```
evaluation_result: "NO TRADE"
failed_at: (first failing pipeline step key, e.g. "POI", "LIQ")
pair: inp.pair
direction: inp.direction    ← always empty from Evaluate tab (no direction field)
model: inp.setupType        ← raw key e.g. "reversal_bull" — NOT translated to label
setup_type: inp.setupType   ← same raw key
session: inp.session        ← raw key e.g. "london" — NOT translated to label
htf_bias: inp.htfBias       ← raw key e.g. "bullish" — NOT translated to label
grade: ev.grade
reason: ev.decReason
trade_date: ISO date string
evaluated_at: ISO timestamp
rifc_pip_size, rifc_timeframe, eql_sweep_distance, eqh_sweep_distance,
opposing_zone_status, dxy_structure_detail
```

**Column mismatch with `create_evaluations_table.sql`:** The SQL schema defines these columns: `id, pair, session, direction, evaluation_result, failed_at, failure_reason, pipeline_snapshot, trade_date, created_at`. The migration `add_precision_validation_columns.sql` adds 7 more: `rifc_pip_size, rifc_timeframe, eql_sweep_distance, eqh_sweep_distance, opposing_zone_status, dxy_structure_detail, why_not_taken`.

The `insertEvaluation` function writes to columns **not defined in any schema file**: `model`, `setup_type`, `reason`, `evaluated_at`, `htf_bias`, `grade`. These will either fail silently if the Supabase table schema was created exactly from the SQL files, or succeed if those columns were added manually. The `pipeline_snapshot` column defined in the SQL is **not written** by `insertEvaluation` — the full pipeline state at rejection time is not persisted.

**Severity: High**  
**Root causes:**
1. Evaluation logging is manual/opt-in — evaluations are discarded unless the user explicitly clicks the log button.
2. `insertEvaluation` writes raw keys for `model`, `session`, `htf_bias` — violating the human-readable label principle.
3. Six columns written to `evaluations` are not defined in any schema migration file.
4. `pipeline_snapshot` (defined in the schema) is not written, losing the full evaluation context.
5. `direction` is always empty from the Evaluate tab.

**Recommended fix direction:**
- Automatically log NO TRADE evaluations when the pipeline produces `NO_TRADE` and the user resets or navigates away (use a `useEffect` cleanup or a "reset" confirmation).
- Translate `model`, `session`, `htf_bias` to human-readable labels before inserting (reuse the same label maps from `addToJournal`).
- Add missing columns to the SQL schema or write a migration to align the schema with what the code actually inserts.
- Persist `pipeline_snapshot` as JSONB so each NO TRADE evaluation contains the full state that caused rejection.

---

## Section 6 — Current Schema vs Course Taxonomy Gap

### 6.1 Trades Table Schema Inventory

The following columns are written by `addToJournal` (lines 4523–4589):

| Column | Type | Notes |
|---|---|---|
| `pair` | text | Label (e.g. "EURUSD") |
| `setup` | text | Human-readable label (e.g. "Bullish Reversal") |
| `session` | text | Human-readable label (e.g. "London") |
| `htf_bias` | text | Human-readable label (e.g. "Bullish") |
| `direction` | text | Derived label "LONG" / "SHORT" (see Section 2) |
| `poi` | text | Free text POI description |
| `liquidity` | text | Comma-joined label string |
| `model` | text | Human-readable label |
| `grade` | text | "A+", "A", "B", "REJECTED" |
| `outcome` | text | Human-readable label (but comparison bug — see Section 1) |
| `r_achieved` | numeric | Float |
| `notes` | text | Free text |
| `pipeline` | jsonb | Full pipeline snapshot + all inp fields |
| `screenshots` | jsonb | Array of compressed base64 strings |
| `trade_date` | date | YYYY-MM-DD |
| `rifc_pip_size` | numeric | Precision validation — numeric |
| `rifc_timeframe` | text | "M1", "M2", "M3", or "M5" |
| `eql_sweep_distance` | numeric | Precision validation — numeric |
| `eqh_sweep_distance` | numeric | Precision validation — numeric |
| `opposing_zone_status` | text | "Fresh" or "Spent" |
| `dxy_structure_detail` | text | Free text |
| `why_not_taken` | text | Free text, only for valid-not-taken outcome |

Additional columns from `add_precision_validation_columns.sql` that are also written to `trades`: the 7 listed above (rifc_pip_size through why_not_taken) are confirmed present.

**Total explicit columns written: ~21** (plus whatever Supabase auto-generates: `id`, `created_at`).

Granular fields stored **only inside the `pipeline` JSONB blob** (not as top-level columns):
- `poiLocation`, `poiSizePips`, `poiType`, `m5Build`, `m5Ind`, `m5Push`
- `liquidityType` (array of raw keys)
- `multiLayerTrap`, `trapWho`, `trapClarity`
- `dispQuality`, `fvgPresent`
- `failType`, `firstLeg`, `secondLeg`
- `bosStatus`
- `entryIdea`, `ltfConfirm`, `stopPips`, `riskPct`, `estRR`, `rangeLoc`, `htfBias`, `isBacktest`

These blob fields are not queryable by Supabase without JSONB operators — they cannot be used in analytics, filtering, or AI training without extraction.

### 6.2 Taxonomy Gap Matrix

| # | Course Taxonomy Category | Status | Evidence |
|---|---|---|---|
| a | **CHoCH 3-stage event log** (First Sign / Pre-Confirming / Confirmed) | MISSING | No column for CHoCH stage classification. `bosStatus` in pipeline blob is binary (yes/wait/no). No "First Sign / Pre-Confirming / Confirmed" distinction exists anywhere in the schema or UI. |
| b | **Liquidity Tier** (Macro/Session/Internal) **+ State** (RUN / Swept X / Resting $$$) **+ Source** (EQH, EQL, Asia Hi/Lo, Frankfurt Hi/Lo, Session Hi/Lo, Previous Day, Trendline Liquidity) | PARTIAL | Liquidity Source is captured in `liquidityType` array (blob) and `liquidity` column (label string). Tier is implicit in the label but not a separate queryable column. Liquidity State (RUN / Swept / Resting) has no representation anywhere in the schema or UI. |
| c | **Wyckoff Phase** (Accumulation / Mark Up / Distribution / Mark Down) | MISSING | Not referenced in any field, constant, or UI element anywhere in WTA1.jsx. |
| d | **Engineered Pullback flag** | MISSING | No boolean flag. The closest is `multiLayerTrap` (blob) but it is not specific to engineered pullbacks. |
| e | **Failed BOS / Complex Pullback / Liquidity Trap flag** | MISSING | No explicit boolean flag. `failType` (blob) captures No HH / No LL. "Complex Pullback" is a sequence type in the Backtest Log but not in the Evaluate tab or trades table. |
| f | **POI Behaviour** (Respected / Swept-Reversed / Disrespected) | MISSING | No field for post-entry POI behaviour. `fvgPresent` (blob) is a pre-entry check, not a post-entry classification. |
| g | **S.C.A.L.P Checklist** (5 boolean gates) | MISSING | The SCALP acronym (Spot impulse, Premium/Discount, Assess POIs, Liquidity grab, Position entry) has no representation in the schema, UI, or pipeline evaluation steps. |
| h | **Killzone flag** + **Never-trade rule violations** | MISSING | The session field captures the time window but there is no boolean killzone flag. Never-trade rule violations (5min break, 15min sweep) have no representation. The Discipline Panel tracks trades/day but not rule violations at this granularity. |
| i | **Timeframe rule flags** (5min = continuation, 15min = reversal) | MISSING | No field for timeframe-based rule classification. |
| j | **DXY State** (Confirms / Rejects / Neutral / Not Checked) | PARTIAL | `dxy_structure_detail` is a free-text column (not a structured enum). The Live Mode tab has a binary DXY aligned/not-aligned toggle (line 2084–2089) but this is not persisted. The Evaluate tab requires `dxy_structure_detail` for EURUSD/GBPUSD but stores it as free text, not a queryable enum. No "Not Checked" state is stored. |

**Summary count:** EXISTS: 0, PARTIAL: 2 (Liquidity Source, DXY State), MISSING: 8

---

## Appendix — Additional Observations (Not in Original Scope)

### A1. `backtest` column name

`normaliseTrade` at line 68 reads `t.backtest` as a fallback for `isBacktest`. There is no `backtest` column in the insert payload — the column used is implicit from `pipeline.inp.isBacktest`. The `backtest` fallback will always be falsy.

### A2. Supabase Anon Key Exposed

Line 5 contains `const SUPABASE_ANON_KEY = 'sb_publishable_7vQBgE8Wx0bzlgHEkl5sJA_9A1esyZO'`. This is a publishable anon key (intentional for frontend use), but the code comment at line 9 warns that the Anthropic API key should be environment-variable-gated. The Anthropic API key at line 12 is correctly gated behind `import.meta.env?.VITE_ANTHROPIC_KEY`. No production secrets are hardcoded.

### A3. `evaluated_at` vs `created_at` in evaluations

`insertEvaluation` writes `evaluated_at` (line 879) but the SQL schema defines `created_at` with a default. If the `evaluations` table was built strictly from the SQL file, `evaluated_at` does not exist as a column and will be silently ignored by Supabase.

### A4. Double `onClick` on Reset Button

Line 1274 defines a `<button>` with two `onClick` attributes — the first is a broken expression (`onClick={()=>set("setupType","")&&setShowSave(false)&&Object.entries(EMPTY).forEach(([k,v])=>set(k,v))||setInp&&setInp(EMPTY)}`), the second (line 1276) is `onClick={()=>{Object.entries(EMPTY).forEach(([k,v])=>set(k,v));}}`. The second `onClick` overrides the first in React (only the last prop wins). The net effect is that only `EMPTY` is applied via `set` — `setShowSave(false)` is never called. This is a minor bug — the save form stays open after reset.

**Severity: Low**

---

## Summary Severity Table

| # | Finding | Severity |
|---|---|---|
| 1.2 | `outcome` case mismatch — Supabase saves capitalised label but all comparisons use lowercase key | **Critical** |
| 2.1 | `direction` not a form field — derived from `htfBias`, wrong for reversal setups | **High** |
| 5 | NO TRADE evaluations are manual/opt-in; `evaluations` insert writes undefined columns, raw keys, and omits `pipeline_snapshot` | **High** |
| 4.3 | Liquidity key detail view map missing `hopw`, `london_h`, `london_l` — raw keys render | **Medium** |
| 6 | 8 of 10 course taxonomy categories absent from schema; 2 partial | **Medium** (for AI training) |
| 3 | Invalid date fix — already resolved | **None** |
| 2.2 | `model` field — saves correctly as label | **None** |
| A4 | Double `onClick` on Reset, `setShowSave` not called | **Low** |
