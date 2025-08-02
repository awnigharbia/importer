import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Bunny Storage
  BUNNY_STORAGE_ZONE: z.string(),
  BUNNY_ACCESS_KEY: z.string(),
  BUNNY_CDN_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Sentry
  SENTRY_DSN: z.string().optional(),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  // Server
  PORT: z.string().default('3000').transform(Number),
  TUS_PATH: z.string().default('/uploads'),
  TEMP_DIR: z.string().default('./temp'),

  // Node Environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // Jobs
  MAX_RETRY_ATTEMPTS: z.string().default('3').transform(Number),
  JOB_TIMEOUT_MS: z.string().default('1800000').transform(Number),
  CLEANUP_INTERVAL_MS: z.string().default('300000').transform(Number),

  // Download limits
  MAX_FILE_SIZE_MB: z.string().default('5000').transform(Number),
  DOWNLOAD_TIMEOUT_MS: z.string().default('600000').transform(Number),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.string().default('900000').transform(Number),
  RATE_LIMIT_MAX_REQUESTS: z.string().default('100').transform(Number),

  // Google Drive API
  GOOGLE_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Invalid environment variables:');
      error.errors.forEach((err) => {
        console.error(`  ${err.path.join('.')}: ${err.message}`);
      });
      process.exit(1);
    }
    throw error;
  }
}

export const env = validateEnv();