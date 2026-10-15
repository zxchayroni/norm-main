import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../lib/server/auth';
import { getPool } from '../../../lib/server/db';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

interface ProfileData {
	fullName: string;
	firstName: string;
	lastName: string;
	patronymic: string;
	email: string | null;
	phone: string | null;
}

function fail(error: string, status: number): Response {
	return new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });
}

export const GET: APIRoute = async ({ locals }) => {
	if (!locals.user) return fail('Требуется авторизация.', 401);
	const result = await getPool().query(
		`SELECT concat_ws(' ', NULLIF(btrim(last_name), ''), NULLIF(btrim(first_name), '')) AS "fullName",
		        first_name AS "firstName", last_name AS "lastName",
		        patronymic, email, phone
		 FROM users WHERE id = $1 AND is_active`,
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
	if (!Object.keys(body).length || Object.keys(body).some((key) => !['fullName', 'firstName', 'lastName', 'patronymic', 'email', 'phone'].includes(key))) {
		return fail('Укажите допустимые поля профиля.', 400);
	}
	const legacyNameParts = typeof body.fullName === 'string' ? body.fullName.trim().split(/\s+/) : [];
	const firstName = body.firstName ?? legacyNameParts[0];
	const lastName = body.lastName ?? legacyNameParts[1] ?? '';
	const patronymic = body.patronymic ?? legacyNameParts.slice(2).join(' ');
	const hasName = body.fullName !== undefined || body.firstName !== undefined || body.lastName !== undefined || body.patronymic !== undefined;
	const fullName = [lastName, firstName, patronymic].map((part) => typeof part === 'string' ? part.trim() : '').filter(Boolean).join(' ');
	if (
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
		(body.phone !== undefined && body.phone !== null && (typeof body.phone !== 'string' || body.phone.trim().length > 40))
	) return fail('Проверьте имя, электронную почту и телефон.', 400);

	const assignments: string[] = [];
	const values: unknown[] = [];
	const set = (column: string, value: unknown) => {
		values.push(value);
		assignments.push(`${column} = $${values.length}`);
	};
	if (hasName) {
		set('full_name', fullName);
		set('first_name', firstName.trim());
		set('last_name', lastName.trim());
		set('patronymic', patronymic.trim());
	}
	if (body.email !== undefined) set('email', typeof body.email === 'string' ? body.email.trim() || null : null);
	if (body.phone !== undefined) set('phone', typeof body.phone === 'string' ? body.phone.trim() || null : null);
	values.push(locals.user.id);

	const client = await getPool().connect();
	let updatedUser: ProfileData;
	try {
		await client.query('BEGIN');
		const updated = await client.query<ProfileData>(
			`UPDATE users SET ${assignments.join(', ')} WHERE id = $${values.length} AND is_active
			 RETURNING concat_ws(' ', NULLIF(btrim(last_name), ''), NULLIF(btrim(first_name), '')) AS "fullName",
			           first_name AS "firstName", last_name AS "lastName",
			           patronymic, email, phone`,
			values,
		);
		if (!updated.rowCount) {
			await client.query('ROLLBACK');
			return fail('Пользователь не найден.', 404);
		}
		await client.query('COMMIT');
		updatedUser = updated.rows[0];
	} catch (error) {
		await client.query('ROLLBACK').catch((rollbackError: unknown) => console.error('Failed to rollback profile update:', rollbackError));
		console.error('Failed to save account profile:', error);
		return fail('Не удалось сохранить сведения учетной записи.', 500);
	} finally {
		client.release();
	}

	let auditWarning: string | undefined;
	try {
		await getPool().query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address, details)
			 VALUES ($1, 'profile_updated', 'user', $4, 'success', $2, $3::jsonb)`,
			[locals.user.id, clientAddress, JSON.stringify({ fields: Object.keys(body) }), locals.user.id],
		);
	} catch (error) {
		console.error('Profile was saved, but its audit event could not be recorded:', error);
		auditWarning = 'Данные сохранены, но не удалось записать действие в журнал.';
	}

	return new Response(JSON.stringify({ user: updatedUser, warning: auditWarning }), { headers: jsonHeaders });
};