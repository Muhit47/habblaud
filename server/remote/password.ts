// Remote access password stored in project .env (HABBLAUD_REMOTE_PASSWORD=scrypt:...).
// When absent or empty, generates secure random passphrase (4 words in current locale), prints
// once to console on startup, and appends to .env so future runs retain it.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export interface PasswordHash {
  logN: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

/** 2^15 with r=8: ~32 MB and dozens of ms per attempt; costly for brute force, cheap for login. */
export const DEFAULT_LOG_N = 15;
const KEY_LEN = 32;
const SALT_LEN = 16;
const HASH_RE = /^scrypt:(\d{1,2}):(\d{1,2}):(\d{1,2}):([A-Za-z0-9_-]{16,}):([A-Za-z0-9_-]{40,})$/;

function maxmem(logN: number, r: number): number {
  // scrypt consumes ~128 * N * r bytes; buffer to stay within Node's default 32 MB limit.
  return 256 * 2 ** logN * r;
}

function derive(password: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  return new Promise((ok, fail) =>
    scrypt(password.normalize('NFC'), salt, KEY_LEN, { N: 2 ** logN, r, p, maxmem: maxmem(logN, r) }, (err, key) => (err ? fail(err) : ok(key))),
  );
}

export async function hashPassword(password: string, logN = DEFAULT_LOG_N): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const r = 8;
  const p = 1;
  const hash = await derive(password, salt, logN, r, p);
  return `scrypt:${logN}:${r}:${p}:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

/** Parses hash; undefined when format invalid or parameters unreasonable. */
export function parsePasswordHash(value: string | undefined): PasswordHash | undefined {
  const m = HASH_RE.exec(value?.trim() ?? '');
  if (!m) return undefined;
  const [logN, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (logN < 10 || logN > 20 || r < 1 || r > 32 || p < 1 || p > 16) return undefined;
  const hash = Buffer.from(m[5], 'base64url');
  if (hash.length !== KEY_LEN) return undefined;
  return { logN, r, p, salt: Buffer.from(m[4], 'base64url'), hash };
}

/** Verifies password in constant time (scrypt runs unconditionally, even on empty password). */
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const key = await derive(password, stored.salt, stored.logN, stored.r, stored.p);
  return key.length === stored.hash.length && timingSafeEqual(key, stored.hash);
}
