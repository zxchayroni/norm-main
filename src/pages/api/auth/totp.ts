import type { APIRoute } from 'astro';
import argon2 from 'argon2';
import { assertSameOrigin } from '../../../lib/server/auth';
import { getPool } from '../../../lib/server/db';
import { createTotp, decryptTotpSecret, encryptTotpSecret, matchingTotpCounter } from '../../../lib/server/totp';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function fail(error: string, status: number): Response {
	return new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });
}

export const GET: APIRoute = async ({ locals }) => {
	if (!locals.user) return fail('Требуется авторизация.', 401);
	const result = await getPool().query<{ enabled: boolean }>(
		'SELECT totp_secret IS NOT NULL AS enabled FROM users WHERE id = $1 AND is_active',
		[locals.user.id],
	);
	if (!result.rowCount) return fail('Пользователь не найден.', 404);
	return new Response(JSON.stringify({ enabled: result.rows[0].enabled }), { headers: jsonHeaders });
};

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return fail('Недопустимый источник запроса.', 403);
	if (!locals.user) return fail('Требуется авторизация.', 401);
	let input: unknown;
	try { input = await request.json(); } catch { return fail('Некорректный формат запроса.', 400); }
	if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Некорректный запрос настройки 2FA.', 400);
	const body = input as Record<string, unknown>;
	const client = await getPool().connect();
	try {
		if (
			body.action === 'start' && Object.keys(body).length === 2 &&
			typeof body.password === 'string' && body.password.length > 0 && body.password.length <= 1024
		) {
			const user = await client.query<{ username: string; passwordHash: string; enabled: boolean }>(
				'SELECT username, password_hash AS "passwordHash", totp_secret IS NOT NULL AS enabled FROM users WHERE id = $1 AND is_active',
				[locals.user.id],
			);
			if (!user.rowCount) return fail('Пользователь не найден.', 404);
			if (!(await argon2.verify(user.rows[0].passwordHash, body.password))) return fail('Текущий пароль указан неверно.', 400);
			if (user.rows[0].enabled) return fail('Двухфакторная аутентификация уже включена.', 409);
			let totp;
			let encryptedSecret: string;
			try {
				totp = createTotp(user.rows[0].username);
				encryptedSecret = encryptTotpSecret(totp.secret.base32);
			} catch { return fail('На сервере не настроен ключ шифрования TOTP.', 503); }
			await client.query(
				`UPDATE users SET totp_pending_secret = $1, totp_pending_expires_at = NOW() + INTERVAL '10 minutes',
				 totp_pending_attempts = 0 WHERE id = $2`,
				[encryptedSecret, locals.user.id],
			);
			return new Response(JSON.stringify({ secret: totp.secret.base32, uri: totp.toString() }), { headers: jsonHeaders });
		}

		if (body.action === 'enable' && Object.keys(body).sort().join(',') === 'action,token' && typeof body.token === 'string' && /^\d{6}$/.test(body.token)) {
			await client.query('BEGIN');
			const user = await client.query<{ pendingSecret: string | null; expiresAt: Date | null; enabled: boolean; attempts: number }>(
				`SELECT totp_pending_secret AS "pendingSecret", totp_pending_expires_at AS "expiresAt", totp_secret IS NOT NULL AS enabled,
				 totp_pending_attempts AS attempts
				 FROM users WHERE id = $1 AND is_active FOR UPDATE`,
				[locals.user.id],
			);
			const pending = user.rows[0];
			if (!user.rowCount || pending.enabled || !pending.pendingSecret || !pending.expiresAt || pending.expiresAt <= new Date() || pending.attempts >= 5) {
				await client.query('ROLLBACK');
				return fail('Настройка истекла. Начните подключение заново.', 400);
			}
			let secret: string;
			try { secret = decryptTotpSecret(pending.pendingSecret); } catch { throw new Error('Failed to decrypt pending TOTP secret.'); }
			const counter = matchingTotpCounter(secret, body.token);
			if (counter === null) {
			await client.query(
					`UPDATE users SET totp_pending_secret = CASE WHEN totp_pending_attempts >= 4 THEN NULL ELSE totp_pending_secret END,
					 totp_pending_expires_at = CASE WHEN totp_pending_attempts >= 4 THEN NULL ELSE totp_pending_expires_at END,
					 totp_pending_attempts = CASE WHEN totp_pending_attempts >= 4 THEN 0 ELSE totp_pending_attempts + 1 END
					 WHERE id = $1`,
					[locals.user.id],
				);
				await client.query('COMMIT');
				return fail('Код не подошёл. Проверьте время на устройстве. После пяти ошибок настройку нужно начать заново.', 400);
			}
			await client.query(
				`UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL,
				 totp_pending_expires_at = NULL, totp_pending_attempts = 0, totp_failed_attempts = 0, totp_last_counter = $2 WHERE id = $1`,
				[locals.user.id, counter],
			);
			await client.query(
				`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
				 VALUES ($1, 'totp_enabled', 'user', $2, 'success', $3)`,
				[locals.user.id, locals.user.id, clientAddress],
			);
			await client.query('COMMIT');
			return new Response(JSON.stringify({ enabled: true }), { headers: jsonHeaders });
		}

		if (
			body.action === 'disable' && Object.keys(body).sort().join(',') === 'action,password,token' &&
			typeof body.password === 'string' && body.password.length > 0 && body.password.length <= 1024 &&
			typeof body.token === 'string' && /^\d{6}$/.test(body.token)
		) {
			await client.query('BEGIN');
			const user = await client.query<{ passwordHash: string; secret: string | null; lastCounter: string | null; failedAttempts: number; lockoutUntil: Date | null }>(
				`SELECT password_hash AS "passwordHash", totp_secret AS secret, totp_last_counter AS "lastCounter",
				 totp_failed_attempts AS "failedAttempts", lockout_until AS "lockoutUntil"
				 FROM users WHERE id = $1 AND is_active FOR UPDATE`,
				[locals.user.id],
			);
			if (!user.rowCount || !user.rows[0].secret) {
				await client.query('ROLLBACK');
				return fail('Не удалось подтвердить пароль или состояние 2FA.', 400);
			}
			if (user.rows[0].lockoutUntil && user.rows[0].lockoutUntil > new Date()) {
				await client.query('ROLLBACK');
				return fail('Слишком много неверных попыток. Подождите 15 минут.', 429);
			}
			const passwordMatches = await argon2.verify(user.rows[0].passwordHash, body.password);
			const secret = decryptTotpSecret(user.rows[0].secret);
			const counter = passwordMatches ? matchingTotpCounter(secret, body.token) : null;
			if (counter === null || (user.rows[0].lastCounter !== null && counter <= Number(user.rows[0].lastCounter))) {
				await client.query(
					`UPDATE users SET totp_failed_attempts = totp_failed_attempts + 1,
					 lockout_until = CASE WHEN totp_failed_attempts >= 4 THEN NOW() + INTERVAL '15 minutes' ELSE lockout_until END
					 WHERE id = $1`,
					[locals.user.id],
				);
				await client.query('COMMIT');
				return fail('Неверный или уже использованный код подтверждения.', 400);
			}
			await client.query(
				`UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_pending_expires_at = NULL,
				 totp_last_counter = NULL, totp_failed_attempts = 0, lockout_until = NULL WHERE id = $1`,
				[locals.user.id],
			);
			await client.query(
				`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
				 VALUES ($1, 'totp_disabled', 'user', $2, 'success', $3)`,
				[locals.user.id, locals.user.id, clientAddress],
			);
			await client.query('COMMIT');
			return new Response(JSON.stringify({ enabled: false }), { headers: jsonHeaders });
		}

		return fail('Проверьте данные настройки 2FA.', 400);
	} catch (error) {
		await client.query('ROLLBACK').catch((rollbackError: unknown) => console.error('Failed to rollback TOTP change:', rollbackError));
		throw error;
	} finally {
		client.release();
	}
};