import { z } from 'zod';

// Environment schema. Validated once at boot; a bad env fails fast and loud.
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  API_KEY: z.string().min(1, 'API_KEY is required'),
  WEBHOOK_SECRET: z.string().min(1, 'WEBHOOK_SECRET is required'),
  // Confirmations required before a deposit off-ramps (pending -> available).
  CONFIRMATIONS: z.coerce.number().int().positive().default(12),
  PORT: z.coerce.number().int().positive().default(3000),

  // --- Chain watcher (Solana devnet) -----------------------------------------
  // All optional with defaults so the current boot path is unchanged; the
  // watcher only starts when ENABLE_CHAIN_WATCHER=true is set explicitly.
  SOLANA_RPC_URL: z.string().default('https://api.devnet.solana.com'),
  // SPL mint watched for deposits. Vendor abstraction as config: point this at
  // our own 6dp test mint (scripts/devnet-setup.ts) or at Circle's devnet USDC
  // (4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU) — no code change either way.
  SOLANA_USDC_MINT: z.string().default(''),
  // Wallet (owner) whose associated token account receives client deposits.
  SOLANA_DEPOSIT_OWNER: z.string().default(''),
  // Off by default: an env without Solana config must boot exactly as before.
  // z.coerce.boolean() would treat the string 'false' as true, hence the transform.
  ENABLE_CHAIN_WATCHER: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  WATCHER_POLL_MS: z.coerce.number().int().positive().default(15_000),
  // Off-ramp fee in basis points taken on the USD leg (100 = 1%).
  OFFRAMP_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(100),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid environment: ${issues}`);
  }
  return parsed.data;
}

export const config: Config = load();
