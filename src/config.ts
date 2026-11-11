import 'dotenv/config';

function positiveInt(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);

  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function requireSecret(): string {
  const secret = process.env.JWT_SECRET ?? '';

  if (secret.length < 32 || secret.startsWith('REPLACE_')) {
    throw new Error('Set a random JWT_SECRET of at least 32 characters');
  }
  return secret;
}

function requireOrigin(isProduction: boolean): string {
  const origin = process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173';

  if (new URL(origin).origin !== origin) {
    throw new Error('FRONTEND_ORIGIN must be an origin');
  }
  if (isProduction && !origin.startsWith('https://')) {
    throw new Error('Production FRONTEND_ORIGIN requires HTTPS');
  }
  return origin;
}

export function config() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const isProduction = process.env.NODE_ENV === 'production';

  return {
    secret: requireSecret(),
    origin: requireOrigin(isProduction),
    secure: isProduction,

    issuer: process.env.JWT_ISSUER ?? 'pr8-api',
    audience: process.env.JWT_AUDIENCE ?? 'pr8-web',

    port: positiveInt('PORT', 3000, 65535),
    accessTtl: positiveInt('ACCESS_TTL_SECONDS', 900, 3600),
    sessionTtl: positiveInt('SESSION_TTL_SECONDS', 604800, 2592000),

    sessionRetentionDays: positiveInt('SESSION_RETENTION_DAYS', 7, 365),
    sessionCleanupIntervalSeconds: positiveInt('SESSION_CLEANUP_INTERVAL_SECONDS', 3600, 86400),
  };
}
