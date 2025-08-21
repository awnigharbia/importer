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
  JOB_TIMEOUT_MS: z.string().default('7200000').transform(Number), // 2 hours for large files
  CLEANUP_INTERVAL_MS: z.string().default('300000').transform(Number),

  // Download limits (supports 10GB+ files with streaming)
  MAX_FILE_SIZE_MB: z.string().default('15000').transform(Number), // 15GB max file size
  DOWNLOAD_TIMEOUT_MS: z.string().default('7200000').transform(Number), // 2 hour timeout for large files

  // Node.js Memory (optimized for streaming large files on 4GB server)
  NODE_MAX_OLD_SPACE_SIZE: z.string().default('3072').transform(Number), // 3GB heap (75% of 4GB)
  STREAM_BUFFER_SIZE: z.string().default('8').transform(Number), // 8KB buffer chunks for maximum memory efficiency

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.string().default('900000').transform(Number),
  RATE_LIMIT_MAX_REQUESTS: z.string().default('100').transform(Number),

  // Google API settings
  GOOGLE_API_KEY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),


  // Authentication
  JWT_SECRET: z.string().default('your-super-secret-jwt-key-change-this-in-production'),
  AUTH_USERNAME: z.string().default('admin'),
  AUTH_PASSWORD: z.string().default('admin123'),
  JWT_EXPIRES_IN: z.string().default('24h'),

  // Encode Admin API
  ENCODE_ADMIN_API_URL: z.string().default('https://encode-admin.fly.dev/api'),
  ENCODE_ADMIN_API_KEY: z.string().default('e9aaae3945ba3937b04feeb14de0c407'),
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
      // process.exit(1);
    }
    throw error;
  }
}

export const env = validateEnv();