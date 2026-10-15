import type { APIRoute } from 'astro';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { assertSameOrigin, createSession } from '../../../lib/server/auth';
import { audit, getPool } from '../../../lib/server/db';
import { decryptTotpSecret, matchingTotpCounter } from '../../../lib/server/totp';

const dummyPasswordHash = argon2.hash(randomBytes(32), { type: argon2.argon2id });

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
	if (!assertSameOrigin(request)) {
		return new Response(JSON.stringify({ error: 'Недопустимый источник запроса.' }), {
			status: 403,
			headers: { 'content-type': 'application/json; charset=utf-8' },
		});
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: 'Некорректный формат запроса.' }), {
			status: 400,
			headers: { 'content-type': 'application/json; charset=utf-8' },
		});
	}

	if (!body || typeof body !== 'object' || Array.isArray(body) || !('username' in body) || !('password' in body)) {
		return new Response(JSON.stringify({ error: 'Укажите логин и пароль.' }), {
			status: 400,
			headers: { 'content-type': 'application/json; charset=utf-8' },
		});
	}

	const username = body.username;
	const password = body.password;
	const totpToken = 'totpToken' in body ? body.totpToken : undefined;
	if (
		typeof username !== 'string' || typeof password !== 'string' ||
		username.length > 100 || password.length > 1024 ||
		!username.trim() || !password ||
		(totpToken !== undefined && (typeof totpToken !== 'string' || !/^\d{6}$/.test(totpToken))) ||
		Object.keys(body).some((key) => !['username', 'password', 'totpToken'].includes(key))
	) {
		return new Response(JSON.stringify({ error: 'Укажите корректные логин и пароль.' }), {
			status: 400,
			headers: { 'content-type': 'application/json; charset=utf-8' },
		});
	}

	const pool = getPool();
	const normalizedUsername = username.trim().toLowerCase();
	const result = await pool.query<{
		id: string;
		password_hash: string;
		is_active: boolean;
		lockout_until: Date | null;
		totp_secret: string | null;
		totp_last_counter: string | null;
	}>(
		`SELECT id, password_hash, is_active, lockout_until, totp_secret, totp_last_counter
		 FROM users
		 WHERE username = $1`,
		[normalizedUsername],
	);
	const user = result.rows[0];
	const passwordMatches = user
		? await argon2.verify(user.password_hash, password)
		: (await argon2.verify(await dummyPasswordHash, password), false);

	if (!user || !user.is_active || (user.lockout_until && user.lockout_until > new Date()) || !passwordMatches) {
		if (user && user.is_active && !(user.lockout_until && user.lockout_until > new Date())) {
			await pool.query(
				`UPDATE users
				 SET failed_login_count = CASE
				       WHEN lockout_until IS NOT NULL AND lockout_until <= NOW() THEN 1
				       ELSE failed_login_count + 1
				     END,
				     lockout_until = CASE
				       WHEN (CASE
				         WHEN lockout_until IS NOT NULL AND lockout_until <= NOW() THEN 1
				         ELSE failed_login_count + 1
				       END) >= 5 THEN NOW() + INTERVAL '15 minutes'
				       ELSE NULL
				     END
				 WHERE id = $1`,
				[user.id],
			);
		}

		await audit(user?.id ?? null, 'login_failed', 'user', user?.id ?? null, 'failure', {}, clientAddress);
		return new Response(JSON.stringify({ error: 'Неверный логин или пароль.' }), {
			status: 401,
			headers: { 'content-type': 'application/json; charset=utf-8' },
		});
	}
	if (user?.totp_secret) {
		const remembered = await pool.query(
			`UPDATE users
			 SET totp_failed_attempts = 0, failed_login_count = 0, lockout_until = NULL, last_login_at = NOW()
			 WHERE id = $1 AND is_active AND totp_verified_at > NOW() - INTERVAL '1 hour'
			 RETURNING id`,
			[user.id],
		);
		if (!remembered.rowCount) {
			if (totpToken === undefined) {
				return new Response(JSON.stringify({ requiresTotp: true }), {
					headers: { 'content-type': 'application/json; charset=utf-8' },
				});
			}
			const secret = decryptTotpSecret(user.totp_secret);
			const matchedCounter = matchingTotpCounter(secret, totpToken);
			const accepted = matchedCounter === null ? null : await pool.query(
				`UPDATE users
				 SET totp_last_counter = $2, totp_verified_at = NOW(), totp_failed_attempts = 0,
				     failed_login_count = 0, lockout_until = NULL, last_login_at = NOW()
				 WHERE id = $1 AND is_active AND (totp_last_counter IS NULL OR totp_last_counter < $2)
				 RETURNING id`,
				[user.id, matchedCounter],
			);
			if (!accepted?.rowCount) {
				await pool.query(
				`UPDATE users
				 SET totp_failed_attempts = totp_failed_attempts + 1,
				     lockout_until = CASE WHEN totp_failed_attempts >= 4 THEN NOW() + INTERVAL '15 minutes' ELSE lockout_until END
				 WHERE id = $1 AND is_active`,
					[user.id],
				);
				await audit(user.id, 'login_failed', 'user', user.id, 'failure', { reason: 'totp' }, clientAddress);
				return new Response(JSON.stringify({ error: 'Неверный или уже использованный код подтверждения.' }), {
					status: 401,
					headers: { 'content-type': 'application/json; charset=utf-8' },
				});
			}
		}
	} else {
		await pool.query(
			'UPDATE users SET failed_login_count = 0, totp_failed_attempts = 0, lockout_until = NULL, last_login_at = NOW() WHERE id = $1',
			[user.id],
		);
	}

	await createSession(user.id, request, cookies, clientAddress);
	await audit(user.id, 'login', 'user', user.id, 'success', {}, clientAddress);

	return new Response(JSON.stringify({ ok: true }), {
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
};
