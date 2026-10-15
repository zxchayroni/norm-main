import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../lib/server/auth';
import { getPool } from '../../../lib/server/db';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function fail(error: string, status: number): Response {
	return new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });
}

function parseTitles(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length < 1 || value.length > 100) return null;
	const titles: string[] = [];
	for (const title of value) {
		if (typeof title !== 'string' || !title.trim() || title.trim().length > 300) return null;
		titles.push(title.trim());
	}
	return titles;
}

export const GET: APIRoute = async ({ locals }) => {
	const pool = getPool();
	const [departments, items] = await Promise.all([
		pool.query<{ id: string; name: string }>(
			`SELECT id::text, name
			 FROM dictionaries
			 WHERE type = 'department' AND is_active
			 ORDER BY sort_order, name`,
		),
		pool.query<{ id: string; departmentId: string; title: string; isCompleted: boolean }>(
			`SELECT item.id::text, item.department_id::text AS "departmentId",
			        item.title, item.is_completed AS "isCompleted"
			 FROM department_knowledge_items item
			 JOIN dictionaries department ON department.id = item.department_id
			 WHERE department.type = 'department' AND department.is_active
			 ORDER BY department.sort_order, department.name, lower(item.title), item.id`,
		),
	]);
	return new Response(JSON.stringify({
		departments: departments.rows,
		items: items.rows,
		canAdd: locals.user?.role !== 'reader',
		canDelete: locals.user?.role === 'admin',
		canUpdate: locals.user?.role !== 'reader',
	}), { headers: jsonHeaders });
};

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return fail('Недопустимый источник запроса.', 403);
	if (!locals.user || locals.user.role === 'reader') return fail('Недостаточно прав для изменения базы знаний.', 403);

	let input: unknown;
	try {
		input = await request.json();
	} catch {
		return fail('Некорректный формат запроса.', 400);
	}
	if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Укажите название документа.', 400);

	const body = input as Record<string, unknown>;
	const departmentId = body.departmentId;
	const titles = parseTitles(body.titles);
	if (
		Object.keys(body).some((key) => !['departmentId', 'titles'].includes(key)) ||
		typeof departmentId !== 'string' || !/^[1-9]\d{0,17}$/.test(departmentId) ||
		titles === null
	) return fail('Укажите подразделение и от 1 до 100 названий длиной до 300 символов каждое.', 400);

	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		const department = await client.query(
			`SELECT id FROM dictionaries
			 WHERE id = $1 AND type = 'department' AND is_active`,
			[departmentId],
		);
		if (!department.rowCount) {
			await client.query('ROLLBACK');
			return fail('Подразделение не найдено.', 400);
		}
		const result = await client.query<{ id: string }>(
			`INSERT INTO department_knowledge_items (department_id, title, created_by)
			 SELECT $1, input.title, $3
			 FROM unnest($2::text[]) AS input(title)
			 ON CONFLICT DO NOTHING
			 RETURNING id::text`,
			[departmentId, titles, locals.user.id],
		);
		const createdIds = result.rows.map((row) => row.id);
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address, details)
			 VALUES ($1, 'knowledge_items_created', 'knowledge_item', NULL, 'success', $2, $3::jsonb)`,
			[locals.user.id, clientAddress, JSON.stringify({ departmentId, itemIds: createdIds, createdCount: createdIds.length })],
		);
		await client.query('COMMIT');
		return new Response(JSON.stringify({
			createdCount: createdIds.length,
			skippedCount: titles.length - createdIds.length,
		}), { status: 201, headers: jsonHeaders });
	} catch (error) {
		await client.query('ROLLBACK').catch((rollbackError: unknown) => console.error('Failed to rollback knowledge item creation:', rollbackError));
		throw error;
	} finally {
		client.release();
	}
};
