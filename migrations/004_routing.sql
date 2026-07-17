-- 004_routing.sql — routing engine (standing treasury rules) + vendor payout
-- tracking + provider statements for reconciliation.
--
-- A route is the orchestration promise of DESIGN §2: "when X arrives,
-- automatically send Y" — fired exactly ONCE per triggering deposit
-- (UNIQUE(route_id, trigger_transfer_id), guardrail R4 / ADR-013), evaluated
-- against net available post-fees, all legs reserved in ONE transaction in
-- declared `seq` order, and parked in a visible/retryable `insufficient_funds`
-- state when the total does not fit. No partial fills.
--
-- Money is BIGINT integer minor units everywhere. Idempotent: safe to re-run.

-- A standing rule: when the trigger account receives a confirmed off-ramp,
-- execute the actions below in order.
CREATE TABLE IF NOT EXISTS routes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  trigger_account_id UUID NOT NULL REFERENCES accounts(id),
  active             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_routes_trigger_account ON routes(trigger_account_id);

-- One outbound action of a route, executed in `seq` order. `provider` is a
-- registry key (src/vendors/registry.ts) — routing never knows provider shapes.
-- For cross-currency legs (e.g. USD books -> USDT payout) the pair of
-- conversion accounts joins the two single-currency legs at an explicit rate:
-- source_amount_minor (what the user is debited, USD cents) and amount_minor
-- (what the counterparty receives, destination currency minor units) record
-- that rate explicitly (ADR-003/ADR-006 — 1:1 peg for the challenge).
CREATE TABLE IF NOT EXISTS route_actions (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id                          UUID NOT NULL REFERENCES routes(id),
  seq                               INT  NOT NULL,
  provider                          TEXT NOT NULL,
  amount_minor                      BIGINT NOT NULL CHECK (amount_minor > 0),
  currency                          TEXT NOT NULL,
  source_amount_minor               BIGINT NOT NULL CHECK (source_amount_minor > 0),
  source_currency                   TEXT NOT NULL DEFAULT 'USD',
  destination_account_id            UUID NOT NULL REFERENCES accounts(id),
  source_conversion_account_id      UUID REFERENCES accounts(id),
  destination_conversion_account_id UUID REFERENCES accounts(id),
  UNIQUE (route_id, seq)
);

-- One firing of a route for one trigger transfer. The UNIQUE pair IS the
-- idempotency guardrail R4: a redelivered "off-ramp confirmed" event cannot
-- fire the route twice — only the winning insert reserves funds.
-- status: reserving | reserved | insufficient_funds | completed | failed
--   `insufficient_funds` is deliberately visible and RETRYABLE: the execution
--   row survives, the partial reservations do not (savepoint rollback).
CREATE TABLE IF NOT EXISTS route_executions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id            UUID NOT NULL REFERENCES routes(id),
  trigger_transfer_id UUID NOT NULL REFERENCES transfers(id),
  status              TEXT NOT NULL DEFAULT 'reserving',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (route_id, trigger_transfer_id)
);

-- One outbound leg of an execution. Once reserved, each leg lives its own
-- lifecycle (the ACH can settle while the USDT send is still confirming):
--   reserved -> initiated -> settled | failed        (monotonic, guarded UPDATEs)
-- idempotency_key = route:{execution_id}:leg:{seq} — deterministic, doubles as
-- the provider clientReference so providers can dedupe re-dispatches (ADR-011).
-- transfer_id is the ledger reservation (hold) transfer for the leg.
CREATE TABLE IF NOT EXISTS route_legs (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id                      UUID NOT NULL REFERENCES route_executions(id),
  seq                               INT  NOT NULL,
  provider                          TEXT NOT NULL,
  status                            TEXT NOT NULL DEFAULT 'reserved',
  idempotency_key                   TEXT NOT NULL UNIQUE,
  external_ref                      TEXT,
  transfer_id                       UUID REFERENCES transfers(id),
  user_account_id                   UUID NOT NULL REFERENCES accounts(id),
  destination_account_id            UUID NOT NULL REFERENCES accounts(id),
  amount_minor                      BIGINT NOT NULL CHECK (amount_minor > 0),
  currency                          TEXT NOT NULL,
  source_amount_minor               BIGINT NOT NULL CHECK (source_amount_minor > 0),
  source_currency                   TEXT NOT NULL,
  source_conversion_account_id      UUID REFERENCES accounts(id),
  destination_conversion_account_id UUID REFERENCES accounts(id),
  failure_reason                    TEXT,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (execution_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_route_legs_provider_ref ON route_legs(provider, external_ref);
CREATE INDEX IF NOT EXISTS idx_route_legs_execution    ON route_legs(execution_id);

-- Provider-side settlement facts, as ingested from settle webhooks / polls.
-- This is external truth for the reconciliation job (DESIGN §9): the recon
-- anti-joins compare these rows against ledger transfers. Append-only by usage;
-- UNIQUE(provider, external_ref) makes a redelivered settlement a keyed no-op.
CREATE TABLE IF NOT EXISTS provider_statements (
  id           BIGSERIAL PRIMARY KEY,
  provider     TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency     TEXT NOT NULL,
  settled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, external_ref)
);

-- ---------------------------------------------------------------------------
-- Seeds: destination + conversion accounts for the Northwind route, and the
-- route itself. Fixed UUIDs (style of 002_seed.sql) for curl / tests.
-- ---------------------------------------------------------------------------

INSERT INTO accounts (id, name, currency, kind) VALUES
  -- The roaster's bank account, as an external USD mirror (ACH destination).
  ('00000000-0000-0000-0000-000000000010', 'roaster_ach_destination_usd',    'USD',  'external'),
  -- The supplier's Polygon address, as an external USDT mirror (6 decimals).
  ('00000000-0000-0000-0000-000000000011', 'supplier_polygon_usdt',          'USDT', 'external'),
  -- Paired conversion accounts joining the USD and USDT legs of a cross-asset
  -- transfer at an explicit rate (DESIGN §4.1): an aged nonzero balance here
  -- IS money mid-conversion, visible by query.
  ('00000000-0000-0000-0000-000000000012', 'conversion_usd',                 'USD',  'conversion'),
  ('00000000-0000-0000-0000-000000000013', 'conversion_usdt',                'USDT', 'conversion')
ON CONFLICT (id) DO NOTHING;

INSERT INTO spend_guards (account_id) VALUES
  ('00000000-0000-0000-0000-000000000010'),
  ('00000000-0000-0000-0000-000000000011'),
  ('00000000-0000-0000-0000-000000000012'),
  ('00000000-0000-0000-0000-000000000013')
ON CONFLICT (account_id) DO NOTHING;

-- The Northwind standing rule: when sub-account ...002 receives a confirmed
-- off-ramp, (1) pay the roaster $4,200.00 by ACH via acmepay, then (2) send
-- 600 USDT (6dp) on Polygon via polygon-usdt, debiting $600.00 at the 1:1 peg.
INSERT INTO routes (id, name, trigger_account_id, active) VALUES
  ('00000000-0000-0000-0000-000000000100', 'northwind-pay-roaster-and-supplier',
   '00000000-0000-0000-0000-000000000002', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO route_actions (id, route_id, seq, provider,
                           amount_minor, currency, source_amount_minor, source_currency,
                           destination_account_id,
                           source_conversion_account_id, destination_conversion_account_id) VALUES
  -- $4,200.00 = 420000 USD cents, same-currency fiat leg.
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000100', 1, 'acmepay',
   420000, 'USD', 420000, 'USD',
   '00000000-0000-0000-0000-000000000010', NULL, NULL),
  -- 600 USDT = 600000000 minor units (6dp); user debited $600.00 = 60000 cents
  -- at the explicit 1:1 peg, joined through the conversion pair.
  ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000100', 2, 'polygon-usdt',
   600000000, 'USDT', 60000, 'USD',
   '00000000-0000-0000-0000-000000000011',
   '00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000013')
ON CONFLICT (id) DO NOTHING;
