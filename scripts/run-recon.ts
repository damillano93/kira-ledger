import pg from 'pg';
import { runRecon, type ReconMismatch } from '../src/recon/recon.js';
import type { EventLogger } from '../src/observability/events.js';

// End-of-day reconciliation CLI (DESIGN §9) — cron/CI friendly:
//
//   DATABASE_URL=postgres://... npx tsx scripts/run-recon.ts [--max-age-minutes 60] [--json]
//
// Prints a human-readable report (or raw JSON with --json), emits the same
// structured recon.* event lines the server would, and exits non-zero when any
// mismatch is found — so a nightly cron or a CI gate fails loudly.
//
// Read-only by construction: recon reports, it never edits. The correction for
// any finding is a future compensating transfer through suspense, posted by
// ops — new append-only entries, never a mutation.
//
// Only DATABASE_URL is needed (deliberately not src/config.ts, which demands
// the full server env — a recon cron box has no business holding API keys).

function parseArgs(argv: string[]): { maxAgeMinutes: number | undefined; json: boolean } {
  let maxAgeMinutes: number | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--max-age-minutes') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        process.stderr.write('--max-age-minutes requires a positive integer\n');
        process.exit(2);
      }
      maxAgeMinutes = value;
      i += 1;
    } else {
      process.stderr.write(`unknown argument: ${arg}\nusage: run-recon.ts [--max-age-minutes N] [--json]\n`);
      process.exit(2);
    }
  }
  return { maxAgeMinutes, json };
}

// Emit the exact same structured event lines the server's pino logger would
// (`{"event":"recon.mismatch.settled_no_entry",...}`), so cron logs are
// greppable/alertable with the same queries as fly logs.
const stdoutEventLogger: EventLogger = {
  info: (obj) => process.stdout.write(`${JSON.stringify({ level: 'info', ...obj })}\n`),
  warn: (obj) => process.stdout.write(`${JSON.stringify({ level: 'warn', ...obj })}\n`),
  error: (obj) => process.stdout.write(`${JSON.stringify({ level: 'error', ...obj })}\n`),
};

function formatMismatch(m: ReconMismatch): string {
  const amount = m.amountMinor === null ? '?' : m.amountMinor;
  const currency = m.currency ?? '';
  const age = m.ageMinutes === null ? '' : ` age=${m.ageMinutes}m`;
  return `  [${m.type}] ${m.side} ref=${m.ref} amount=${amount} ${currency}${age}\n      ${m.detail}`;
}

async function main(): Promise<void> {
  const { maxAgeMinutes, json } = parseArgs(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(2);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const report = await runRecon(pool, { maxAgeMinutes, logger: stdoutEventLogger });

    if (json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      const c = report.checked;
      process.stdout.write(
        `\nreconciliation report @ ${report.runAt}\n` +
          `  checked: ${c.chainStatements} chain statement(s), ${c.providerStatements} provider statement(s), ` +
          `${c.pendingTransfers} pending transfer(s), ${c.openLegs} open leg(s), ` +
          `${c.guardedAccounts} guarded account(s)\n` +
          `  SLA threshold: ${report.maxAgeMinutes} minute(s)\n\n`,
      );
      if (report.ok) {
        process.stdout.write('OK — ledger, chain and provider statements all agree.\n');
      } else {
        process.stdout.write(`${report.mismatches.length} MISMATCH(ES):\n`);
        for (const m of report.mismatches) {
          process.stdout.write(`${formatMismatch(m)}\n`);
        }
        process.stdout.write(
          '\nrecon reports, it never edits: correct via compensating entries through suspense.\n',
        );
      }
    }

    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(`recon failed: ${String(err)}\n`);
  process.exit(2);
});
