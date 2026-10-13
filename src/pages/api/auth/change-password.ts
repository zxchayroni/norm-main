import type { APIRoute } from 'astro';
import argon2 from 'argon2';
import { createHash } from 'node:crypto';
import { assertSameOrigin, SESSION_COOKIE } from '../../../lib/server/auth';
import { getPool } from '../../../lib/server/db';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function fail(error: string, status: number): Response {
	return new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });
}

export const POST: APIRoute = async ({ request, cookies, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return fail('Недопустимый источник запроса.', 403);
	if (!locals.user) return fail('Требуется авторизация.', 401);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return fail('Некорректный формат запроса.', 400);
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return fail('Укажите текущий и новый пароль.', 400);
	}

	const input = body as Record<string, unknown>;
	if (
		Object.keys(input).some((key) => !['currentPassword', 'newPassword'].includes(key)) ||
		typeof input.currentPassword !== 'string' || !input.currentPassword || input.currentPassword.length > 1024 ||
		typeof input.newPassword !== 'string' || input.newPassword.length < 12 || input.newPassword.length > 1024
	) return fail('Введите текущий пароль и новый пароль длиной от 12 до 1024 символов.', 400);
	if (input.currentPassword === input.newPassword) return fail('Новый пароль должен отличаться от текущего.', 400);

	const token = cookies.get(SESSION_COOKIE)?.value;
	if (!token || !/^[a-f0-9]{64}$/i.test(token)) return fail('Сессия истекла. Войдите снова.', 401);
	const tokenHash = createHash('sha256').update(token).digest();

	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		const userResult = await client.query<{ password_hash: string }>(
			'SELECT password_hash FROM users WHERE id = $1 AND is_active FOR UPDATE',
			[locals.user.id],
		);
		if (!userResult.rowCount || !(await argon2.verify(userResult.rows[0].password_hash, input.currentPassword))) {
			await client.query('ROLLBACK');
			return fail('Текущий пароль указан неверно.', 400);
		}

		const passwordHash = await argon2.hash(input.newPassword, { type: argon2.argon2id });
		await client.query(
			`UPDATE users
			 SET password_hash = $1, failed_login_count = 0, lockout_until = NULL
			 WHERE id = $2`,
			[passwordHash, locals.user.id],
		);
		await client.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [locals.user.id, tokenHash]);
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
			 VALUES ($1, 'password_changed', 'user', $2, 'success', $3)`,
			[locals.user.id, locals.user.id, clientAddress],
		);
		await client.query('COMMIT');
		return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
	} catch (error) {
		await client.query('ROLLBACK').catch((rollbackError: unknown) => {
			console.error('Failed to rollback password change:', rollbackError);
		});
		throw error;
	} finally {
		client.release();
	}
};
