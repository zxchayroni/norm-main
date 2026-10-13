import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../../lib/server/auth';
import { getPool } from '../../../../lib/server/db';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
function fail(error: string, status: number): Response {
	return new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });
}

export const PATCH: APIRoute = async ({ params, request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return fail('Недопустимый источник запроса.', 403);
	if (locals.user?.role !== 'admin') return fail('Недостаточно прав.', 403);
	const id = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(id)) return fail('Некорректный идентификатор записи.', 400);
	let input: unknown;
	try { input = await request.json(); } catch { return fail('Некорректный формат запроса.', 400); }
	if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Укажите поля записи.', 400);
	const body = input as Record<string, unknown>;
	if (
		Object.keys(body).some((key) => !['name', 'isActive', 'sortOrder'].includes(key)) ||
		(body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 200)) ||
		(body.isActive !== undefined && typeof body.isActive !== 'boolean') ||
		(body.sortOrder !== undefined && (!Number.isInteger(body.sortOrder) || Number(body.sortOrder) < 0 || Number(body.sortOrder) > 100000))
	) return fail('Некорректные значения полей.', 400);

	const assignments: string[] = [];
	const values: unknown[] = [];
	for (const [field, column] of [['name', 'name'], ['isActive', 'is_active'], ['sortOrder', 'sort_order']] as const) {
		if (body[field] === undefined) continue;
		values.push(field === 'name' ? (body[field] as string).trim() : body[field]);
		assignments.push(`${column} = $${values.length}`);
	}
	if (!assignments.length) return fail('Нет полей для изменения.', 400);
	values.push(id);
	const idParameter = values.length;
	values.push(locals.user.id, clientAddress, JSON.stringify({ fields: Object.keys(body) }));
	const userParameter = values.length - 2;
	const ipParameter = values.length - 1;
	const detailsParameter = values.length;
	try {
		const result = await getPool().query<{ id: string }>(
			`WITH updated AS (
				UPDATE dictionaries SET ${assignments.join(', ')} WHERE id = $${idParameter} RETURNING id
			), audited AS (
				INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address, details)
				SELECT $${userParameter}, 'dictionary_updated', 'dictionary', updated.id::text, 'success', $${ipParameter}, $${detailsParameter}::jsonb
				FROM updated
				RETURNING id
			)
			SELECT id FROM updated`,
			values,
		);
		if (!result.rowCount) return fail('Запись справочника не найдена.', 404);
		return new Response(JSON.stringify({ id: result.rows[0].id }), { headers: jsonHeaders });
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
			return fail('Такая запись справочника уже существует.', 409);
		}
		throw error;
	}
};

export const DELETE: APIRoute = async ({ params, request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return fail('Недопустимый источник запроса.', 403);
	if (locals.user?.role !== 'admin') return fail('Недостаточно прав.', 403);
	const id = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(id)) return fail('Некорректный идентификатор записи.', 400);
	const result = await getPool().query<{ id: string }>(
		`WITH updated AS (
			UPDATE dictionaries SET is_active = FALSE WHERE id = $1 AND is_active RETURNING id
		), audited AS (
			INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
			SELECT $2, 'dictionary_disabled', 'dictionary', updated.id::text, 'success', $3
			FROM updated
			RETURNING id
		)
		SELECT id FROM updated`,
		[id, locals.user.id, clientAddress],
	);
	if (!result.rowCount) return fail('Активная запись не найдена.', 404);
	return new Response(null, { status: 204 });
};
