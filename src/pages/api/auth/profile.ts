import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../lib/server/auth';
import { getPool } from '../../../lib/server/db';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function fail(error: string, status: number): Response {
	return new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });
}

export const GET: APIRoute = async ({ locals }) => {
	if (!locals.user) return fail('Требуется авторизация.', 401);
	const result = await getPool().query(
		'SELECT full_name AS "fullName", email, phone FROM users WHERE id = $1 AND is_active',
		[locals.user.id],
	);
	if (!result.rowCount) return fail('Пользователь не найден.', 404);
	return new Response(JSON.stringify({ user: result.rows[0] }), { headers: jsonHeaders });
};

export const PATCH: APIRoute = async ({ request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return fail('Недопустимый источник запроса.', 403);
	if (!locals.user) return fail('Требуется авторизация.', 401);

	let input: unknown;
	try { input = await request.json(); } catch { return fail('Некорректный формат запроса.', 400); }
	if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Укажите данные профиля.', 400);
	const body = input as Record<string, unknown>;
	if (!Object.keys(body).length || Object.keys(body).some((key) => !['fullName', 'email', 'phone'].includes(key))) {
		return fail('Укажите допустимые поля профиля.', 400);
	}
	if (
		(body.fullName !== undefined && (typeof body.fullName !== 'string' || !body.fullName.trim() || body.fullName.trim().length > 200)) ||
		(body.email !== undefined && body.email !== null && (typeof body.email !== 'string' || body.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email))) ||
		(body.phone !== undefined && body.phone !== null && (typeof body.phone !== 'string' || body.phone.trim().length > 40))
	) return fail('Проверьте имя, электронную почту и телефон.', 400);

	const assignments: string[] = [];
	const values: unknown[] = [];
	const set = (column: string, value: unknown) => {
		values.push(value);
		assignments.push(`${column} = $${values.length}`);
	};
	if (body.fullName !== undefined) set('full_name', body.fullName.trim());
	if (body.email !== undefined) set('email', typeof body.email === 'string' ? body.email.trim() || null : null);
	if (body.phone !== undefined) set('phone', typeof body.phone === 'string' ? body.phone.trim() || null : null);
	values.push(locals.user.id);

	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		const updated = await client.query(
			`UPDATE users SET ${assignments.join(', ')} WHERE id = $${values.length} AND is_active
			 RETURNING full_name AS "fullName", email, phone`,
			values,
		);
		if (!updated.rowCount) {
			await client.query('ROLLBACK');
			return fail('Пользователь не найден.', 404);
		}
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address, details)
			 VALUES ($1, 'profile_updated', 'user', $1, 'success', $2, $3::jsonb)`,
			[locals.user.id, clientAddress, JSON.stringify({ fields: Object.keys(body) })],
		);
		await client.query('COMMIT');
		return new Response(JSON.stringify({ user: updated.rows[0] }), { headers: jsonHeaders });
	} catch (error) {
		await client.query('ROLLBACK').catch((rollbackError: unknown) => console.error('Failed to rollback profile update:', rollbackError));
		throw error;
	} finally {
		client.release();
	}
};