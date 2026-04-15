-- nexo — Supabase schema
-- Run this once in the Supabase SQL Editor:
-- https://supabase.com/dashboard/project/rhhttbxaesnvmwhtwmgj/sql/new

-- ═══════════════════════════════════════════════════════════════════
-- predictions — daily snapshot of every reservation's risk assessment
-- ═══════════════════════════════════════════════════════════════════
-- One row per (reservation_id, snapshot_date). Re-running /api/score
-- on the same day UPSERTs the existing row. The outcome columns are
-- filled in later by the /api/outcomes cron once the reservation's
-- check-out date has passed and Mews reports the final state.

create table if not exists predictions (
  id uuid primary key default gen_random_uuid(),
  reservation_id text not null,
  prop text,
  snapshot_date date not null default current_date,
  created_at timestamptz not null default now(),

  -- Raw feature vector as captured at scoring time (jsonb blob).
  -- Used later by /api/train to reconstruct training sets from history.
  features jsonb not null,

  -- Model output
  model_version text not null,
  score int not null,
  level text not null,
  override text,
  predicted_prob real not null,

  -- Outcome (filled by /api/outcomes cron after check-out)
  outcome text check (outcome in ('cancelled', 'stayed', 'no_show', 'other')),
  outcome_checked_at timestamptz,
  outcome_final_at timestamptz,

  unique (reservation_id, snapshot_date)
);

create index if not exists predictions_snapshot_idx on predictions (snapshot_date desc);
create index if not exists predictions_reservation_idx on predictions (reservation_id);
create index if not exists predictions_outcome_idx on predictions (outcome, snapshot_date desc);
create index if not exists predictions_unresolved_idx on predictions (outcome, reservation_id) where outcome is null;

-- ═══════════════════════════════════════════════════════════════════
-- model_weights — versioned model coefficients
-- ═══════════════════════════════════════════════════════════════════
-- Populated by /api/train after it finishes a retraining run.
-- api/score loads the row with is_active=true and uses those coefs.
-- Fallback to DEFAULT_WEIGHTS in score.js if no active row exists.

create table if not exists model_weights (
  version text primary key,
  created_at timestamptz not null default now(),

  -- Learned coefs in the same shape as DEFAULT_WEIGHTS in api/score.js
  -- e.g. { "pay": 0.19, "rate": 0.11, ... } plus an "intercept" field.
  coefs jsonb not null,
  feature_names jsonb not null,

  -- Training metadata
  training_samples int not null,
  training_window_start date,
  training_window_end date,

  -- Eval metrics (on the 20% holdout)
  auc real,
  brier real,
  log_loss real,
  calibration_error real,

  is_active boolean not null default false
);

-- Only one active model at a time (enforced by partial unique index).
create unique index if not exists model_weights_single_active
  on model_weights (is_active) where is_active = true;

-- ═══════════════════════════════════════════════════════════════════
-- model_performance — historical snapshots of how the active model
-- has been performing on the most recent window of closed predictions.
-- ═══════════════════════════════════════════════════════════════════
-- Each run of /api/train writes one row here, even if it doesn't
-- deploy a new model (no improvement). Used by the dashboard to show
-- historical trends.

create table if not exists model_performance (
  id uuid primary key default gen_random_uuid(),
  model_version text references model_weights(version),
  evaluated_at timestamptz not null default now(),

  window_start date,
  window_end date,
  samples int,

  auc real,
  brier real,
  log_loss real,
  calibration_error real,

  -- 10-bucket reliability diagram as jsonb
  -- [{ bin: 0.1, avg_pred: 0.08, actual_rate: 0.11, count: 42 }, ...]
  reliability_buckets jsonb
);

create index if not exists model_performance_evaluated_idx on model_performance (evaluated_at desc);

-- ═══════════════════════════════════════════════════════════════════
-- Row Level Security
-- ═══════════════════════════════════════════════════════════════════
-- All access goes through the service key from serverless functions,
-- so we enable RLS to block any direct access from the anon/public key.

alter table predictions enable row level security;
alter table model_weights enable row level security;
alter table model_performance enable row level security;

-- No policies = no access for anon. Service role bypasses RLS automatically.
