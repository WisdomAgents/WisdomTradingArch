-- ============================================================
--  Migration: add_phase_scores_columns
--  Adds 5-Phase evaluation fields to backtest_logs table.
--  Safe to run multiple times (IF NOT EXISTS guards).
--
--  Run in: Supabase Dashboard → SQL Editor → New query → Run
-- ============================================================

-- ── Phase checkpoint booleans (Phase 1 — Continuation model) ──
ALTER TABLE backtest_logs
  ADD COLUMN IF NOT EXISTS p1_hh_ll_breaks_key      boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS p1_buildup_created        boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS p1_engineered_pullback    boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS p1_micro_poi_confirm      boolean DEFAULT false;

-- ── Phase checkpoint booleans (Phase 1 — Reversal model) ──────
ALTER TABLE backtest_logs
  ADD COLUMN IF NOT EXISTS p1_ll_hh_into_htf         boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS p1_macro_liq_sweep         boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS p1_displacement_into_poi   boolean DEFAULT false;

-- ── Phase checkpoint booleans (Phase 4) ───────────────────────
ALTER TABLE backtest_logs
  ADD COLUMN IF NOT EXISTS p4_micro_poi_present      boolean DEFAULT false;

-- ── Phase numeric scores ───────────────────────────────────────
ALTER TABLE backtest_logs
  ADD COLUMN IF NOT EXISTS phase_1_score     smallint,
  ADD COLUMN IF NOT EXISTS phase_2_score     smallint,
  ADD COLUMN IF NOT EXISTS phase_3_score     smallint,
  ADD COLUMN IF NOT EXISTS phase_4_score     smallint,
  ADD COLUMN IF NOT EXISTS phase_5_score     smallint,
  ADD COLUMN IF NOT EXISTS phase_total_score smallint;

-- ── Auto grade and conflict flag ──────────────────────────────
ALTER TABLE backtest_logs
  ADD COLUMN IF NOT EXISTS auto_grade           text,
  ADD COLUMN IF NOT EXISTS grade_conflict       boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS phase_override_reason text;

-- ── Verification: confirm all new columns exist ───────────────
SELECT
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'backtest_logs'
  AND column_name  IN (
    'p1_hh_ll_breaks_key', 'p1_buildup_created', 'p1_engineered_pullback', 'p1_micro_poi_confirm',
    'p1_ll_hh_into_htf', 'p1_macro_liq_sweep', 'p1_displacement_into_poi',
    'p4_micro_poi_present',
    'phase_1_score', 'phase_2_score', 'phase_3_score', 'phase_4_score', 'phase_5_score',
    'phase_total_score', 'auto_grade', 'grade_conflict', 'phase_override_reason'
  )
ORDER BY column_name;
