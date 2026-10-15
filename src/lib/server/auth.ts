import { createHash, randomBytes } from 'node:crypto';
import type { AstroCookies } from 'astro';
import { SESSION_IDLE_TIMEOUT_SECONDS } from '../session-policy';
import { getPool } from './db';

export { assertSameOrigin } from './origin';

export const SESSION_COOKIE = 'doc_archive_session';
export const SESSION_DURATION_SECONDS = SESSION_IDLE_TIMEOUT_SECONDS;

export interface SessionUser {
	id: string;
	username: string;
	fullName: string;
	role: 'admin' | 'editor' | 'reader';
}

function hashToken(token: string): Buffer {
	return createHash('sha256').update(token).digest();
}

export async function createSession(
	userId: string,
	request: Request,
	cookies: AstroCookies,
	ipAddress: string | null,
): Promise<void> {
	const token = randomBytes(32).toString('hex');
	const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000);

	await getPool().query(
		`INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_address)
		 VALUES ($1, $2, $3, $4, $5)`,
		[userId, hashToken(token), expiresAt, request.headers.get('user-agent'), ipAddress],
	);

	cookies.set(SESSION_COOKIE, token, {
		httpOnly: true,
		secure: new URL(request.url).protocol === 'https:',
		sameSite: 'strict',
		path: '/',
		maxAge: SESSION_DURATION_SECONDS,
	});
}

export async function getSessionUser(request: Request, cookies: AstroCookies): Promise<SessionUser | null> {
	const token = cookies.get(SESSION_COOKIE)?.value;
	if (!token || !/^[a-f0-9]{64}$/i.test(token)) return null;

	const result = await getPool().query<SessionUser>(
		`UPDATE sessions AS s
		 SET last_seen_at = NOW(), expires_at = NOW() + ($2 * INTERVAL '1 second')
		 FROM users AS u
		 WHERE s.token_hash = $1
		   AND s.user_id = u.id
		   AND s.expires_at > NOW()
		   AND u.is_active = TRUE
		 RETURNING u.id, u.username,
		           concat_ws(' ', NULLIF(btrim(u.last_name), ''), NULLIF(btrim(u.first_name), '')) AS "fullName",
		           u.role`,
		[hashToken(token), SESSION_DURATION_SECONDS],
	);

	if (!result.rowCount) return null;

	cookies.set(SESSION_COOKIE, token, {
		httpOnly: true,
		secure: new URL(request.url).protocol === 'https:',
		sameSite: 'strict',
		path: '/',
		maxAge: SESSION_DURATION_SECONDS,
	});
	return result.rows[0];
}

export async function revokeSession(cookies: AstroCookies): Promise<void> {
	const token = cookies.get(SESSION_COOKIE)?.value;
	cookies.delete(SESSION_COOKIE, { path: '/' });

	if (token && /^[a-f0-9]{64}$/i.test(token)) {
		await getPool().query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
	}
}
