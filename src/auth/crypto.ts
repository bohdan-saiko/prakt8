import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';

export function passwordHash(password: string) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export function passwordMatches(hash: string, password: string) {
  return argon2.verify(hash, password);
}

const REFRESH_TOKEN_BYTES = 32;
const REFRESH_TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export function newRefreshToken() {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function validTokenShape(token: unknown): token is string {
  return typeof token === 'string' && REFRESH_TOKEN_FORMAT.test(token);
}
