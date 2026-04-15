# WTA1 — Wisdom Trading Architecture · Project Brief

## What This Project Is

WTA1 is a single-file React trading app (`WTA1.jsx`) built for a discretionary forex/indices trader using an ICT/SMC (Smart Money Concepts) framework. It is deployed on Vercel and uses Supabase as the backend database and storage layer.

The core purpose is to enforce structured, rule-based decision-making before, during, and after every trade. The system acts as a real-time trade evaluator, pipeline checklist, journal, analytics engine, and backtest logger — all in one file.

The primary pairs traded include EUR/USD, GBP/USD, USD/JPY, XAU/USD, US30, and NAS100.

---

## Architecture Overview

### Tech Stack
- **Frontend:** React (single JSX file, Tailwind CSS utility classes)
- **Backend:** Supabase (PostgreSQL + Storage for chart screenshots)
- **Deployment:** Vercel
- **Database tables:** `trades`, `evaluations`, `backtest_logs`
- **Storage bucket:** `chart-screenshots`

### File Structure
Everything lives in one file — `WTA1.jsx`. This includes all constants, evaluation engines, analytics, UI components, and tab views. No separate CSS or JS files.

---

## What Has Been Built

### 1. Pipeline Evaluation Engine (Evaluate Tab)
An 8-stage sequential pipeline that evaluates whether a trade is valid in real time as the user fills in fields:

| Stage | Name | What It Checks |
|-------|------|----------------|
| POI | Point of Interest | Pair, HTF bias, range location, POI size, M5 structure (buildup/inducement/push-out) |
| TIME | Session / Timing | Valid session windows (Frankfurt, London, NY) |
| LIQ | Liquidity | Liquidity pool identified and classified |
| INDUCE | Inducement (Trap) | Who is trapped, trap clarity rating |
| DISP | Displacement | Displacement quality, FVG presence |
| FAIL | Failure Model | No Higher High / No Lower Low failure confirmed |
| BOS | BOS / CHoCH | Structure shift confirmed |
| RIFC | RIFC Entry | Entry at origin, stop size, risk %, RR minimum |

Each stage returns `PASS / FORMING / FAIL / PENDING`. The first FAIL blocks all downstream stages. The pipeline produces a final decision: `VALID TRADE / WAIT / NO TRADE` plus an adaptive grade (`A+ / A / B / REJECTED`).

### 2. Decision Trees (per model type)
Four model-specific checklists:
- **Bullish Reversal** — Bull tap → inducement → bearish disp → No LL → BOS → RIFC
- **Bearish Reversal** — Complex push → supply tap → violent rejection → No HH → BOS → RIFC
- **Bullish Continuation** — Demand below 50% → SMC traps above → BOS → expansion
- **Bearish Continuation** — Supply above 50% → SMC traps below → BOS → expansion

### 3. Analytics Engine (Analytics Tab)
- Win rate breakdowns by: setup type, session, trap clarity, LTF confirmation, displacement quality, grade, multi-layer trap
- Personal weakness detection (flags conditions with <45% win rate over 3+ trades)
- Similar trade finder (scores historical trades by similarity to current setup)
- Adaptive grading (adjusts grade thresholds based on personal win rate history)

### 4. Trade Journal (Journal Tab)
- Full trade logging with outcome (Win / Loss / BE), R achieved, notes, and up to 2 chart screenshots
- Loaded from Supabase `trades` table on mount
- Supports backtest mode (logs with a specific historical date)
- Pre-fill from live evaluation (capture current pipeline state into journal form)
- Delete entries

### 5. Discipline Panel
- Daily trade counter (locks at 2 trades/day)
- Daily P&L tracker (+3R stop / −2R warning)
- Trade management state tracker (ENTRY → CONFIRMATION → CONTINUATION)
- M1 shift + internal BOS confirmation gates for break-even and trailing

### 6. Backtest Log Tab (SQS Engine)
Built as a structured multi-step form for logging backtest trades with a scoring engine.

**SQS (Setup Quality Score):** A 0–100 weighted scoring system:
- Liquidity Tier: Tier 1 = 28pts, Tier 2 = 20pts, Tier 3 = 10pts
- Displacement Quality: Strong = 25pts, Moderate = 14pts, Weak = 6pts
- Sweep Quality: Clean = 10pts, Induced = 7pts, Partial = 3pts
- Structure Confirmation: CHoCH = 10pts, BOS = 7pts
- Inducement Type: up to 10pts (highest of selected)
- Bias Aligned: 8pts
- LTF Confirmation: M1 CHoCH = 7pts, M1 BOS = 6pts, Engulf = 4pts
- Full Sequence Complete: 7pts
- Bonuses for Double Sweep / Complex PB with Strong secondary displacement (+5pts)
- Penalty for override (secondary weaker than primary): −8pts

**SQS Bands:**
| Score | Grade | Meaning |
|-------|-------|---------|
| 85–100 | A+ | All major confluence. Take it. |
| 70–84 | A | Strong confluence. Valid entry. |
| 55–69 | B | Incomplete confluence. Reduced size or skip. |
| 40–54 | C | Significant gaps. Log as NO TRADE. |
| 0–39 | F | Auto NO TRADE. |

**Step-by-step form with 10 sections:**
1. Context (pair, direction, session, HTF bias, bias aligned)
2. Model / Sequence (model type, model status, sequence type)
3. Primary Sweep (liquidity tier/type, sweep quality, sweep distance)
4. Second Sweep — conditional, only for Double Sweep / Complex PB / Multi-Stage (gated: failed continuation required)
5. Displacement / Structure (displacement confirmed, quality, candle close position, CHoCH/BOS, structure confirmation)
6. POI / Inducement (POI type/size, inducement confirmed/type, LTF confirmation, full sequence complete)
7. Entry Details (entry price, stop price, auto-calculated stop distance, target RR, target description)
8. Outcome (result, R achieved, exit reason, trade grade)
9. Rules / Warnings (rule triggered, warning signal, failed at stage)
10. Notes (price context, execution notes, key takeaway, chart screenshot upload)

**Section 10 Counterfactual:** After saving, any log can have a counterfactual added (did the setup play out? what R would it have achieved? was the decision correct?).

---

## Changes Made Over Time (Documented Session)

### Session — Fixes Applied (this session)

All changes are confined to the Backtest Log tab. Nothing outside it was touched.

---

#### Fix 1 — Numeric Input Fix
**Problem:** Number input fields (Entry Price, Stop Price, Target RR, Sweep Distance, POI Size, R Achieved) only accepted one character at a time due to `type="number"` browser handling.

**Solution:** Changed the `NI` component from `type="number"` to `type="text"` with `inputMode="decimal"`. Numbers are still parsed as floats on save.

---

#### Fix 2 — Mandatory Field Validation
**Problem:** The Next button could be pressed even if required fields were empty, resulting in incomplete data being logged.

**Solution:** Added `validationErrors` state and a `validateStep(id)` function. Each step has a defined set of required fields. On pressing Next, validation runs — empty fields get a red ring border and a "Required" message below them. Navigation is blocked until all required fields are filled.

Required fields per step:
- Step 1 (Context): Direction, Session, HTF Bias, Bias Aligned
- Step 2 (Sequence): Model Type (at least one), Sequence Type
- Step 3 (Primary Sweep): Liquidity Type (at least one), Sweep Quality
- Step 5 (Displacement): Displacement Confirmed, Displacement Quality, CHoCH or BOS, Structure Confirmation
- Step 6 (POI): POI Type, Inducement Confirmed, LTF Confirmation, Full Sequence Complete
- Step 8 (Outcome): Result, Trade Grade

---

#### Fix 3 — Liquidity Tier Grouped Layout
**Problem:** Liquidity Tier and Liquidity Type were two separate flat selectors with no visual relationship between tier and the types that belong to it.

**Solution:** Replaced both selectors with a 3-column grid. Each column is a tier with its header and its liquidity type buttons listed underneath. Tapping any type automatically sets the tier. Multiple selections allowed across columns. Selected buttons show a blue ring. Column headers are visually distinct with border-bottom dividers.

Tier 1 — Macro: Weekly High, Weekly Low, PDH, PDL, PDC, Daily Open  
Tier 2 — Session: Asia High/Low/Open, London Open High/Low/Price, London Lunch High/Low, NY Open High/Low/Price, Frankfurt High/Low, Kill Zone High/Low  
Tier 3 — Internal: EQ Highs, EQ Lows, Trendline Liquidity, Internal Range, Swing High, Swing Low

---

#### Fix 4 — Remove Displacement Body Ratio from Form
**Problem:** The Displacement Body Ratio field was in the form but is intended to be auto-populated via a future market data API, not entered manually.

**Solution:** Removed the input field from Step 5 UI entirely. The column remains in `BL_EMPTY` and in the `doSave` serialisation array so the database column is preserved for future API use. Not referenced anywhere in the form or validation.

---

#### Fix 5 — Tooltip Help System
**Problem:** No contextual guidance for field meanings in the form.

**Solution:** Added ⓘ icon tooltips (using the existing `InfoTip` component) to:
- Each Model Type button — explains what each model means
- Each Sequence Type button — explains the sequence mechanics
- Each Liquidity Tier column header — explains the significance of each tier
- Sweep Distance label — explains how to measure it and on which timeframe
- Failed Continuation label — explains what qualifies as a failed continuation
- Candle Close Position label — explains how to measure it (M1 timeframe)

Tooltips appear on hover (desktop) and are non-blocking.

---

#### Fix 6 — Section 9 Rules and Warnings Redesign
**Problem:** Section 9 was designed assuming something had gone wrong. It lacked nuance and had a confusing layout.

**Changes:**
- Added a "No Rules Triggered" button at the top of Rule Triggered. When selected, all other rule buttons grey out and become untappable. Selecting it again deselects.
- Warning Signal Present now has three options: Yes / No / No Warning (was just Yes / No).
- Failed At Stage is now hidden entirely when Result is Win. It only appears for Loss, Break Even, or No Trade results.
- Each rule button now has a ⓘ tooltip explaining the rule.

---

#### Fix 7 — SQS Neutral State
**Problem:** When no fields were filled, the SQS bar showed `0 / F / Auto NO TRADE`, which was misleading — 0 does not mean "no trade", it means no data has been entered yet.

**Solution:** The SQS bar now shows `— Fill in fields to calculate` until at least Liquidity Tier AND Displacement Quality both have values (these are the two highest-weight fields). Once both are filled, scoring begins normally. The Auto NO TRADE badge is also gated on both fields being present.

---

#### Fix 8 — NY 1st Hour Session Added
**Problem:** The NY 1st Hour session window (09:30–10:30 NY / 14:30–15:30 BST) was missing from the session selector.

**Solution:** Added `NY 1st Hour` as a session option in the Backtest Log tab session toggle, positioned between London Open and NY 2nd Hour.

---

## Current State of the System

The system is a complete, production-deployed trading journal and evaluation tool. The Evaluate tab (original pipeline) and all tabs other than Backtest Log remain unchanged from their last build. The Backtest Log tab is now in a much more refined state with proper validation, a cleaner liquidity interface, contextual guidance, and more accurate SQS signalling.

**Outstanding / Future items noted in code:**
- `displacement_body_ratio` column in the database is reserved for future auto-population via market data API
- Section 10 Counterfactual is always added post-hoc from the logs panel (by design)

---

## How to Continue This Project in a New Session

Paste this brief at the top of your prompt, then paste the current `WTA1.jsx` file. Specify which tab you're working on and what changes you need. Always end with: **"Single file WTA1.jsx output only. Do not change anything outside the [tab name] tab."**
