-- Run this in your Supabase SQL editor (Dashboard → SQL Editor → New query)
-- Creates the evaluations table for recording pipeline evaluation outcomes

create table if not exists evaluations (
  id                uuid        primary key default gen_random_uuid(),
  pair              text,
  session           text,
  direction         text,
  evaluation_result text,                          -- 'VALID' or 'NO TRADE'
  failed_at         text,                          -- readable step label, null if VALID
  failure_reason    text,                          -- reason text from system, null if VALID
  pipeline_snapshot jsonb,                         -- full pipeline state at submission
  trade_date        date,
  created_at        timestamptz default now()
);
