# WTA-1 Bug & Feature Request Log

**Last updated:** 16/04/2026  
**Session:** Live backtest logging session

---

## Open Items

*All items from session 16/04/2026 resolved — see Resolved Items below.*

---

### BUG-001 — Date Field Default (Step 1 Context)

**Type:** Bug  
**Priority:** Medium  
**Status:** Open  
**Reported:** 16/04/2026

**Description:**  
The date field on Step 1 (Context) defaults to today's date on every new entry. When a Discord recap is pasted into the auto-fill parser, the date should be extracted from the recap header and used to populate the date field automatically. Currently, users must manually correct the date for every historical backtest entry, defeating part of the purpose of the paste-to-prefill feature.

**Expected behaviour:**  
When a paste is parsed and a date is found in the recap header (any of the supported formats: `YYYY-MM-DD`, `DD/MM/YYYY`, `DD-MM-YYYY`), the date field should be populated with that extracted date. If no date is found in the paste, default to blank (not today's date), prompting the user to enter it manually.

**Affected component:** `BacktestLogTab` — `parsePaste()` function, Step 1 date field initial state.

**Notes:**  
The paste parser already has date extraction logic (`dateM` regex match in `parsePaste()`). The issue is likely that the date field's initial state is set to `new Date().toISOString().slice(0,10)` or similar, and the parsed date is not being applied correctly on paste.

---

### BUG-002 — Model Type Multi-Select Allows Simultaneous Selection (Step 2)

**Type:** Bug  
**Priority:** High  
**Status:** Open  
**Reported:** 16/04/2026

**Description:**  
The Model Type toggle buttons on Step 2 (Model / Sequence) allow more than one model to be selected at the same time. Model Type should be strictly single-select — selecting a second model must deselect the previously selected one. This is a data integrity issue: a trade can only follow one primary model.

**Expected behaviour:**  
Tapping any Model Type button sets that model as the sole selection and deselects all others. The field stores a single string value, not an array.

**Affected component:** `BacktestLogTab` — Step 2 model type toggle group, `entry.model_type` state field.

**Notes:**  
The current implementation stores `model_type` as an array (multi-select pattern reused from liquidity type). It should be refactored to a single-value field with mutually exclusive toggle behaviour matching the Sequence Type selector pattern.

---

### BUG-003 — Missing Liquidity Type: Induced OB (Tier 3, Step 3)

**Type:** Bug / Missing Option  
**Priority:** Medium  
**Status:** Open  
**Reported:** 16/04/2026

**Description:**  
Tier 3 internal liquidity types do not include "Induced OB" as an option. Structural inducement sweeps of order blocks are a distinct and common liquidity pool type in the ICT/SMC framework and should be an explicit selectable option in the Primary Sweep liquidity pool under Tier 3.

**Expected behaviour:**  
"Induced OB" appears as a button in the Tier 3 Internal column of the Step 3 liquidity pool grid, alongside EQ Highs, EQ Lows, Trendline Liquidity, Internal Range, Swing High, and Swing Low.

**Affected component:** `BacktestLogTab` — Step 3 liquidity tier/type grid, Tier 3 button list.

**Notes:**  
The same option should also be added to the paste parser's liquidity type map (`liqMap` in `parsePaste()`) so it can be auto-detected from Discord recaps that reference induced OB sweeps.

---

### BUG-004 — R Achieved Not Auto-Populated on Target Hit (Step 8)

**Type:** Bug / UX  
**Priority:** Medium  
**Status:** Open  
**Reported:** 16/04/2026

**Description:**  
When Result is set to "Win" and Exit Reason is set to "Target Hit" on Step 8 (Outcome), the R Achieved field should automatically populate with the Target RR value entered in Step 7 (Entry Details). Currently it remains blank and the user must manually type the same number a second time, which introduces a risk of transcription error.

**Expected behaviour:**  
When `result === 'Win'` and `exit_reason === 'Target Hit'`, `r_achieved` is automatically set to the value of `target_rr` from Step 7. The field remains editable so the user can override it if the target was only partially filled.

**Affected component:** `BacktestLogTab` — Step 8 outcome section, `entry.r_achieved` field, conditional `useEffect` or `onChange` handler on `result` / `exit_reason`.

---

### BUG-005 — Discord Auto-Fill Not Capturing Primary Sweep Liquidity (Step 3)

**Type:** Bug  
**Priority:** High  
**Status:** Open  
**Reported:** 16/04/2026

**Description:**  
The Discord paste-to-prefill parser is not consistently detecting and populating the Primary Sweep liquidity pool type. Sweep distance and liquidity pool selections require manual input even when the Discord recap explicitly describes the swept level. The parsing logic for sweep-related fields needs a review and likely an expansion of the keyword patterns it recognises.

**Expected behaviour:**  
Common Discord recap phrasings for swept levels (e.g. "swept PDH", "Asia high sweep", "ran the equal highs", "took out the London open high", "swept the trendline", "induced OB swept") are reliably matched and used to populate `liquidity_type` and auto-derive `liquidity_tier`. Sweep distance is parsed where a pip value is stated explicitly.

**Affected component:** `BacktestLogTab` — `parsePaste()`, `liqMap` regex array, sweep distance extraction logic.

**Notes:**  
Current `liqMap` patterns cover the major types but may be too rigid for natural-language Discord writing (e.g. "Asia high" vs "Asia High" vs "the Asian high", "equal highs" vs "EQ highs"). Consider making patterns case-insensitive and adding common informal variants. Sweep distance parsing may also need a new regex targeting pip/point references adjacent to sweep descriptions.

---

### BUG-006 — Tier Classification Display Logic Inverted (Step 3 / SQS Summary)

**Type:** Bug  
**Priority:** Medium  
**Status:** Open  
**Reported:** 16/04/2026

**Description:**  
When multiple liquidity types from different tiers are selected, the system displays the highest tier *number* rather than the highest tier *rank*. In the WTA-1 hierarchy, Tier 1 is the highest significance level and Tier 3 is the lowest. When a Tier 2 type is selected alongside Tier 3 types, the SQS engine and any summary display should classify the entry as Tier 2 (the highest-ranking tier present), not Tier 3.

**Expected behaviour:**  
When multiple tiers are present in `liquidity_type`, the derived `liquidity_tier` used for SQS scoring and display should be the *lowest tier number* present (i.e. highest significance). For example: Tier 2 + Tier 3 selections → classify and score as Tier 2.

**Affected component:** `BacktestLogTab` — Step 3 tier auto-derivation logic (in `parsePaste()` and in the liquidity type button `onChange` handler), SQS display summary.

**Notes:**  
The `BL_TIER_RANK` map (`{ 'Tier 1': 3, 'Tier 2': 2, 'Tier 3': 1 }`) exists in the code and correctly assigns higher rank values to higher-significance tiers. The bug is likely in the downstream logic that reads this map — it may be selecting `max` tier number instead of `max` rank value when deriving the primary tier.

---

## Resolved Items

### BUG-001 — Date Field Default ✓
**Resolved:** 16/04/2026  
`BL_EMPTY.date` changed from `new Date().toISOString().split('T')[0]` to `''`. Date field is now blank on new entry; populated only when parsed from Discord recap.

### BUG-002 — Model Type Multi-Select ✓
**Resolved:** 16/04/2026  
`model_type` refactored from array `[]` to string `''` across all 6 touch points: `BL_EMPTY`, validation, step summary, UI toggle (now single-select), `SumRow`, and `parsePaste` (takes `models[0]`).

### BUG-003 — Missing Liquidity Type: Induced OB ✓
**Resolved:** 16/04/2026  
`'Induced OB'` added to `TIER_COLS` Tier 3 items array and `[/induced\s*ob/i, 'Induced OB']` added to `liqMap` in `parsePaste`.

### BUG-004 — R Achieved Auto-Population ✓
**Resolved:** 16/04/2026  
`useEffect` added in `BacktestLogTab` — when `result === 'Win'` and `exit_reason === 'Target Hit'` and `target_rr` is set and `r_achieved` is empty, auto-populates `r_achieved` from `target_rr`. Manual overrides respected.

### BUG-005 — Discord Auto-Fill Missing Primary Sweep Liquidity ✓
**Resolved:** 16/04/2026  
Three improvements: (1) `liqMap` expanded with natural-language variants — "previous day high/low/close" → PDH/PDL/PDC, "Asian high/low", "Asia Open", "NY Open High/Low", "EQ high/low" variants, "trendline swept"; (2) sweep quality detection broadened to catch "clean sweep", "partial sweep", "induced sweep" natural-language phrases; (3) new `swDistM` regex added to extract pip values from sweep distance descriptions.

### BUG-006 — Tier Classification Display Logic ✓
**Resolved:** 16/04/2026  
Tier button click handler in Step 3 rewritten to compute `derivedTier` from the full set of newly selected items using `TIER_COLS[0].items` (Tier 1) and `TIER_COLS[1].items` (Tier 2) checks. Always resolves to highest significance (lowest tier number) present. Removing the last Tier 2 item correctly reverts to Tier 3 if only Tier 3 items remain.

---

## Change Log

| Date | Entry | Change |
|------|-------|--------|
| 16/04/2026 | BUG-001 through BUG-006 | Initial log created from live backtest session findings |
| 16/04/2026 | BUG-001 through BUG-006 | All 6 items resolved and applied to WTA1.jsx |
