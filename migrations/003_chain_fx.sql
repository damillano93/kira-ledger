-- 003_chain_fx.sql — chain watcher dedupe/statement table + conversion account.
-- Idempotent: safe to run repeatedly (same convention as 001/002).

-- chain_events is BOTH the watcher's persistent dedupe (re-scanning the same
-- signature is a keyed no-op, DESIGN §6 R1 / §8) AND the "chain statement" the
-- reconciliation job (DESIGN §9) anti-joins against the ledger: every row here
-- must have a matching deposit transfer with idempotency_key = chain || ':' || signature,
-- and every 'credited' row a matching offramp transfer.
--
-- status transitions forward only: detected -> credited. The transition is a
-- guarded UPDATE ... WHERE status = 'detected' (rowcount 0 => another worker won).
CREATE TABLE IF NOT EXISTS chain_events (
  id           BIGSERIAL PRIMARY KEY,
  chain        TEXT NOT NULL,                    -- e.g. 'solana-devnet'
  signature    TEXT NOT NULL,                    -- on-chain tx signature/hash
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0), -- token minor units (USDC = 6dp)
  currency     TEXT NOT NULL,                    -- token symbol, e.g. 'USDC'
  mint         TEXT NOT NULL,                    -- SPL mint address observed
  slot         BIGINT NOT NULL,                  -- slot the tx landed in
  status       TEXT NOT NULL DEFAULT 'detected' CHECK (status IN ('detected', 'credited')),
  seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The idempotency guardrail: one ledger effect per (chain, signature), no matter
  -- how many times the poller re-scans or a webhook redelivers the same deposit.
  UNIQUE (chain, signature)
);

CREATE INDEX IF NOT EXISTS idx_chain_events_status ON chain_events(chain, status);

-- Conversion/trading account for the USDC -> USD off-ramp leg. The deferred
-- double-entry trigger balances per CURRENCY, so a cross-currency conversion is
-- two independently-balanced legs pivoting on this account:
--   USDC leg: user pending drain  <-> conversion (absorbs the USDC)
--   USD  leg: conversion          <-> user available + fee
-- Its currency is 'MULTI' because entries carry their own currency per row; this
-- account intentionally holds positions in both legs. Its net position per
-- currency (plus sub-cent conversion residue, see offramp.ts) is an observable
-- recon quantity, not a hidden bucket — it deliberately has NO spend_guards row
-- (like external mirrors, its spendable buckets are not tracked).
INSERT INTO accounts (id, name, currency, kind) VALUES
  ('00000000-0000-0000-0000-000000000020', 'kira_conversion_usdc_usd', 'MULTI', 'conversion')
ON CONFLICT (id) DO NOTHING;
