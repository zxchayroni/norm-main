import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../../lib/server/auth';
import { getPool } from '../../../../lib/server/db';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const types = new Set(['doc_type', 'status', 'department', 'file_kind']);

function fail(error: string, status: number): Response {
	return new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });
}

export const GET: APIRoute = async ({ url, locals }) => {
	const type = url.searchParams.get('type') ?? '';
	if (type && !types.has(type)) return fail('Неизвестный тип справочника.', 400);
	const result = type
		? await getPool().query(
			`SELECT id, type, name, is_active AS "isActive", sort_order AS "sortOrder"
			 FROM dictionaries WHERE type = $1 AND ($2 = 'admin' OR is_active)
			 ORDER BY sort_order, name`,
			[type, locals.user?.role ?? 'reader'],
		)
		: await getPool().query(
			`SELECT id, type, name, is_active AS "isActive", sort_order AS "sortOrder"
			 FROM dictionaries WHERE $1 = 'admin' OR is_active ORDER BY type, sort_order, name`,
			[locals.user?.role ?? 'reader'],
		);
	return new Response(JSON.stringify({ items: result.rows }), { headers: jsonHeaders });
};

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return fail('Недопустимый источник запроса.', 403);
	if (locals.user?.role !== 'admin') return fail('Недостаточно прав.', 403);
	let input: unknown;
	try { input = await request.json(); } catch { return fail('Некорректный формат запроса.', 400); }
	if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Укажите тип и название записи.', 400);
	const body = input as Record<string, unknown>;
	if (
		typeof body.type !== 'string' || !types.has(body.type) ||
		typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 200 ||
		(body.sortOrder !== undefined && (!Number.isInteger(body.sortOrder) || Number(body.sortOrder) < 0 || Number(body.sortOrder) > 100000))
	) return fail('Проверьте тип, название и порядок сортировки.', 400);

	try {
		const result = await getPool().query<{ id: string }>(
			'INSERT INTO dictionaries (type, name, sort_order) VALUES ($1, $2, $3) RETURNING id',
			[body.type, body.name.trim(), body.sortOrder ?? 0],
		);
		await getPool().query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
			 VALUES ($1, 'dictionary_created', 'dictionary', $2, 'success', $3)`,
			[locals.user.id, result.rows[0].id, clientAddress],
		);
		return new Response(JSON.stringify({ id: result.rows[0].id }), { status: 201, headers: jsonHeaders });
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
			return fail('Такая запись справочника уже существует.', 409);
		}
		throw error;
	}
};
