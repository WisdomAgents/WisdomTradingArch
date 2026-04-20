-- ============================================================
--  Migration: add_precision_validation_columns
--  Adds 7 precision-validation fields to trades AND evaluations
--  Safe to run multiple times (IF NOT EXISTS guards).
--
--  Run in: Supabase Dashboard → SQL Editor → New query → Run
-- ============================================================

-- ── trades table ────────────────────────────────────────────
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS rifc_pip_size        numeric,
  ADD COLUMN IF NOT EXISTS rifc_timeframe        text,
  ADD COLUMN IF NOT EXISTS eql_sweep_distance   numeric,
  ADD COLUMN IF NOT EXISTS eqh_sweep_distance   numeric,
  ADD COLUMN IF NOT EXISTS opposing_zone_status text,
  ADD COLUMN IF NOT EXISTS dxy_structure_detail text,
  ADD COLUMN IF NOT EXISTS why_not_taken        text;

-- ── evaluations table ────────────────────────────────────────
ALTER TABLE evaluations
  ADD COLUMN IF NOT EXISTS rifc_pip_size        numeric,
  ADD COLUMN IF NOT EXISTS rifc_timeframe        text,
  ADD COLUMN IF NOT EXISTS eql_sweep_distance   numeric,
  ADD COLUMN IF NOT EXISTS eqh_sweep_distance   numeric,
  ADD COLUMN IF NOT EXISTS opposing_zone_status text,
  ADD COLUMN IF NOT EXISTS dxy_structure_detail text,
  ADD COLUMN IF NOT EXISTS why_not_taken        text;

-- ── Verification: confirm all 14 columns now exist ──────────
SELECT
  table_name,
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('trades', 'evaluations')
  AND column_name IN (
    'rifc_pip_size',
    'rifc_timeframe',
    'eql_sweep_distance',
    'eqh_sweep_distance',
    'opposing_zone_status',
    'dxy_structure_detail',
    'why_not_taken'
  )
ORDER BY table_name, column_name;
