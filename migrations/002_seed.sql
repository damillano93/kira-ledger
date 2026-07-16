-- 002_seed.sql — minimal Northwind flow accounts so the API is testable end-to-end.
-- Fixed UUIDs make them easy to reference from curl / integration tests.
-- Idempotent: safe to run repeatedly.

INSERT INTO accounts (id, name, currency, kind) VALUES
  ('00000000-0000-0000-0000-000000000001', 'northwind_external_usdc', 'USDC', 'external'),
  ('00000000-0000-0000-0000-000000000002', 'northwind_sub1_usd',      'USD',  'user'),
  ('00000000-0000-0000-0000-000000000003', 'kira_platform_fee_usd',   'USD',  'fee')
ON CONFLICT (id) DO NOTHING;

INSERT INTO spend_guards (account_id) VALUES
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000003')
ON CONFLICT (account_id) DO NOTHING;
