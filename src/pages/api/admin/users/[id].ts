import type { APIRoute } from 'astro';
import argon2 from 'argon2';
import { assertSameOrigin } from '../../../../lib/server/auth';
import { getPool } from '../../../../lib/server/db';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const roles = new Set(['admin', 'editor', 'reader']);

function fail(error: string, status: number): Response {
	return new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });
}

export const PATCH: APIRoute = async ({ params, request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return fail('Недопустимый источник запроса.', 403);
	if (locals.user?.role !== 'admin') return fail('Недостаточно прав.', 403);
	const id = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(id)) return fail('Некорректный идентификатор пользователя.', 400);
	let input: unknown;
	try { input = await request.json(); } catch { return fail('Некорректный формат запроса.', 400); }
	if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Укажите изменяемые поля.', 400);
	const body = input as Record<string, unknown>;
	const legacyNameParts = typeof body.fullName === 'string' ? body.fullName.trim().split(/\s+/) : [];
	const hasName = body.fullName !== undefined || body.firstName !== undefined || body.lastName !== undefined || body.patronymic !== undefined;
	const firstName = body.firstName ?? legacyNameParts[0];
	const lastName = body.lastName ?? legacyNameParts[1] ?? '';
	const patronymic = body.patronymic ?? legacyNameParts.slice(2).join(' ');
	const fullName = [lastName, firstName, patronymic].map((part) => typeof part === 'string' ? part.trim() : '').filter(Boolean).join(' ');
	if (
		(body.role !== undefined && (typeof body.role !== 'string' || !roles.has(body.role))) ||
		(body.isActive !== undefined && typeof body.isActive !== 'boolean') ||
		(hasName && (
			typeof firstName !== 'string' || !firstName.trim() || firstName.trim().length > 100 ||
			typeof lastName !== 'string' || lastName.trim().length > 100 ||
			typeof patronymic !== 'string' || patronymic.trim().length > 100 ||
			fullName.length > 200
		)) ||
		(body.email !== undefined && body.email !== null && (
			typeof body.email !== 'string' || body.email.length > 320 ||
			(body.email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()))
		)) ||
		(body.phone !== undefined && body.phone !== null && (typeof body.phone !== 'string' || body.phone.trim().length > 40)) ||
		(body.password !== undefined && (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 1024))
	) return fail('Некорректные значения полей пользователя.', 400);
	if (Object.keys(body).some((key) => !['role', 'isActive', 'fullName', 'firstName', 'lastName', 'patronymic', 'email', 'phone', 'password'].includes(key))) {
		return fail('Запрос содержит неизвестные поля.', 400);
	}

	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query('SELECT pg_advisory_xact_lock(712940116)');
		const userResult = await client.query<{ role: string; is_active: boolean }>(
			'SELECT role, is_active FROM users WHERE id = $1 FOR UPDATE',
			[id],
		);
		if (!userResult.rowCount) {
			await client.query('ROLLBACK');
			return fail('Пользователь не найден.', 404);
		}
		const current = userResult.rows[0];
		const becomesInactiveAdmin = current.role === 'admin' && current.is_active &&
			(body.role !== undefined && body.role !== 'admin' || body.isActive === false);
		if (becomesInactiveAdmin) {
			const activeAdmins = await client.query<{ count: string }>(
				"SELECT COUNT(*)::text AS count FROM users WHERE role = 'admin' AND is_active",
			);
			if (Number(activeAdmins.rows[0].count) <= 1) {
				await client.query('ROLLBACK');
				return fail('Нельзя заблокировать или сменить роль последнего активного администратора.', 409);
			}
		}

		const assignments: string[] = [];
		const values: unknown[] = [];
		const set = (column: string, value: unknown) => {
			values.push(value);
			assignments.push(`${column} = $${values.length}`);
		};
		if (body.role !== undefined) set('role', body.role);
		if (body.isActive !== undefined) set('is_active', body.isActive);
		if (hasName) {
			set('full_name', fullName);
			set('first_name', firstName.trim());
			set('last_name', lastName.trim());
			set('patronymic', patronymic.trim());
		}
		if (body.email !== undefined) set('email', typeof body.email === 'string' ? body.email.trim() || null : null);
		if (body.phone !== undefined) set('phone', typeof body.phone === 'string' ? body.phone.trim() || null : null);
		if (body.password !== undefined) {
			set('password_hash', await argon2.hash(String(body.password), { type: argon2.argon2id }));
			set('failed_login_count', 0);
			set('lockout_until', null);
		}
		if (assignments.length) {
			values.push(id);
			await client.query(`UPDATE users SET ${assignments.join(', ')} WHERE id = $${values.length}`, values);
			await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
			await client.query(
				`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address, details)
				 VALUES ($1, 'user_updated', 'user', $2, 'success', $3, $4::jsonb)`,
				[locals.user.id, id, clientAddress, JSON.stringify({ fields: Object.keys(body) })],
			);
		}
		await client.query('COMMIT');
		return new Response(JSON.stringify({ id, changed: assignments.length > 0 }), { headers: jsonHeaders });
	} catch (error) {
		await client.query('ROLLBACK').catch((rollbackError: unknown) => console.error('Failed to rollback user update:', rollbackError));
		throw error;
	} finally {
		client.release();
	}
};

export const DELETE: APIRoute = async ({ params, request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return fail('Недопустимый источник запроса.', 403);
	if (locals.user?.role !== 'admin') return fail('Недостаточно прав.', 403);
	const id = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(id)) return fail('Некорректный идентификатор пользователя.', 400);
	if (id === locals.user.id) return fail('Нельзя удалить собственную учётную запись.', 409);

	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query('SELECT pg_advisory_xact_lock(712940116)');
		const userResult = await client.query<{ role: string; is_active: boolean; username: string; full_name: string }>(
			'SELECT role, is_active, username, full_name FROM users WHERE id = $1 FOR UPDATE',
			[id],
		);
		if (!userResult.rowCount) {
			await client.query('ROLLBACK');
			return fail('Пользователь не найден.', 404);
		}
		const target = userResult.rows[0];
		if (target.role === 'admin' && target.is_active) {
			const activeAdmins = await client.query<{ count: string }>(
				"SELECT COUNT(*)::text AS count FROM users WHERE role = 'admin' AND is_active",
			);
			if (Number(activeAdmins.rows[0].count) <= 1) {
				await client.query('ROLLBACK');
				return fail('Нельзя удалить последнего активного администратора.', 409);
			}
		}

		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address, details)
			 VALUES ($1, 'user_deleted', 'user', $2, 'success', $3, $4::jsonb)`,
			[locals.user.id, id, clientAddress, JSON.stringify({ username: target.username, fullName: target.full_name })],
		);
		await client.query('DELETE FROM users WHERE id = $1', [id]);
		await client.query('COMMIT');
		return new Response(JSON.stringify({ id, deleted: true }), { headers: jsonHeaders });
	} catch (error) {
		await client.query('ROLLBACK').catch((rollbackError: unknown) => console.error('Failed to rollback user deletion:', rollbackError));
		throw error;
	} finally {
		client.release();
	}
};
