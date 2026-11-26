import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyRequest } from 'fastify';

const derive = promisify(scrypt);
export const SESSION = 'line_pulse_session';
export const CSRF = 'line_pulse_csrf';
export type User = { user_id: string; username: string; role: 'admin' | 'operator' | 'viewer' };
declare module 'fastify' { interface FastifyRequest { user: User | null } }

export const token = () => randomBytes(32).toString('base64url');
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}

export async function passwordMatches(password: string, encoded?: string) {
  const [salt, hash] = (encoded ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
  const actual = await derive(password, salt, 64) as Buffer;
  const expected = Buffer.from(hash, 'hex');
  return Boolean(encoded) && actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function csrfMatches(request: FastifyRequest) {
  const cookie = request.cookies[CSRF];
  const supplied = request.headers['x-csrf-token'];
  if (!cookie || typeof supplied !== 'string') return false;
  return timingSafeEqual(Buffer.from(tokenHash(cookie)), Buffer.from(tokenHash(supplied)));
}
