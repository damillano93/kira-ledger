import { z } from 'zod';

// Environment schema. Validated once at boot; a bad env fails fast and loud.
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  API_KEY: z.string().min(1, 'API_KEY is required'),
  WEBHOOK_SECRET: z.string().min(1, 'WEBHOOK_SECRET is required'),
  // Confirmations required before a deposit off-ramps (pending -> available).
  CONFIRMATIONS: z.coerce.number().int().positive().default(12),
  PORT: z.coerce.number().int().positive().default(3000),
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
