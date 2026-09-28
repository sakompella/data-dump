import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'data_dump_session';

export const sessionToken = (password: string): string =>
	createHmac('sha256', password).update('data-dump session').digest('hex');

export function isValidSession(password: string, token: string | undefined): boolean {
	if (!token) return false;
	const expected = Buffer.from(sessionToken(password));
	const given = Buffer.from(token);
	return given.length === expected.length && timingSafeEqual(given, expected);
}
