-- 001_init.sql — core append-only double-entry ledger schema.
-- All money is stored as signed integer minor units (BIGINT). No floats anywhere.
-- This migration is written to be safely re-runnable (idempotent) so the container
-- can run it on every boot without failing on an already-initialised database.

-- gen_random_uuid() is in core Postgres since v13; pgcrypto is a harmless fallback.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Chart of accounts. `kind` is one of: asset | liability | user | fee | external.
CREATE TABLE IF NOT EXISTS accounts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  currency   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A transfer groups the entries of a single logical money movement.
-- idempotency_key is the primary idempotency guardrail (UNIQUE): the same key
-- must always resolve to the same transfer, never duplicate entries or balances.
CREATE TABLE IF NOT EXISTS transfers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,                 -- deposit | offramp | payout
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | failed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The ledger. APPEND ONLY: rows are never updated or deleted (enforced below).
-- `amount` is signed minor units; per transfer per currency the sum must be zero.
CREATE TABLE IF NOT EXISTS entries (
  id          BIGSERIAL PRIMARY KEY,
  transfer_id UUID NOT NULL REFERENCES transfers(id),
  account_id  UUID NOT NULL REFERENCES accounts(id),
  amount      BIGINT NOT NULL,                   -- signed minor units
  currency    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entries_transfer ON entries(transfer_id);
CREATE INDEX IF NOT EXISTS idx_entries_account  ON entries(account_id);

-- spend_guards — a per-account CONCURRENCY RESERVATION COUNTER, NOT a stored
-- balance (ADR-004, ADR-020). The client's balance is always SUM(entries); this
-- row is rebuildable from the ledger at any time (recon asserts guard ==
-- SUM(entries)). It exists only to serialise concurrent spends via a row lock.
-- Two DISTINCT buckets:
--   headroom_minor = spendable now (a payout may only ever draw on this),
--   pending_minor  = seen but not yet cleared (e.g. an unconfirmed deposit).
-- CHECK (headroom_minor >= 0) is the STRUCTURAL backstop of last resort against
-- overdraw: even if application logic had a bug, the database physically refuses
-- to commit a negative row — overdraft is a constraint violation, not a code path.
CREATE TABLE IF NOT EXISTS spend_guards (
  account_id     UUID PRIMARY KEY REFERENCES accounts(id),
  headroom_minor BIGINT NOT NULL DEFAULT 0 CHECK (headroom_minor >= 0),
  pending_minor  BIGINT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Append-only guard: block any UPDATE or DELETE on entries.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION entries_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'entries is append-only; % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_entries_append_only ON entries;
CREATE TRIGGER trg_entries_append_only
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION entries_append_only();

-- ---------------------------------------------------------------------------
-- STRUCTURAL DOUBLE-ENTRY GUARDRAIL.
-- A DEFERRED constraint trigger validates, at COMMIT, that every affected
-- transfer nets to zero per currency. Unbalanced money is physically
-- uncommittable — double-entry is enforced by the database, not by convention.
-- (Postgres has no deferred CHECK; a per-row deferred constraint trigger that
--  re-checks the whole transfer is the standard equivalent.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_transfer_balanced() RETURNS trigger AS $$
DECLARE
  unbalanced RECORD;
BEGIN
  FOR unbalanced IN
    SELECT currency, SUM(amount) AS total
    FROM entries
    WHERE transfer_id = NEW.transfer_id
    GROUP BY currency
    HAVING SUM(amount) <> 0
  LOOP
    RAISE EXCEPTION 'ledger transfer % is unbalanced for currency %: sum=%',
      NEW.transfer_id, unbalanced.currency, unbalanced.total;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_entries_balanced ON entries;
CREATE CONSTRAINT TRIGGER trg_entries_balanced
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_transfer_balanced();
