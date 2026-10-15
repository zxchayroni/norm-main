import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../lib/server/auth';
import { getPool } from '../../../lib/server/db';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function fail(error: string, status: number): Response {
	return new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });
}

export const PATCH: APIRoute = async ({ params, request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return fail('Недопустимый источник запроса.', 403);
	if (!locals.user || locals.user.role === 'reader') return fail('Недостаточно прав для изменения статуса.', 403);
	const id = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(id)) return fail('Некорректный идентификатор записи.', 400);

	let input: unknown;
	try {
		input = await request.json();
	} catch {
		return fail('Некорректный формат запроса.', 400);
	}
	if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Укажите статус документа.', 400);
	const body = input as Record<string, unknown>;
	if (Object.keys(body).length !== 1 || typeof body.isCompleted !== 'boolean') {
		return fail('Укажите, выполнен ли документ.', 400);
	}

	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		const updated = await client.query<{ id: string; isCompleted: boolean }>(
			`UPDATE department_knowledge_items
			 SET is_completed = $2
			 WHERE id = $1
			 RETURNING id::text, is_completed AS "isCompleted"`,
			[id, body.isCompleted],
		);
		if (!updated.rowCount) {
			await client.query('ROLLBACK');
			return fail('Запись базы знаний не найдена.', 404);
		}
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address, details)
			 VALUES ($1, 'knowledge_item_status_changed', 'knowledge_item', $2, 'success', $3, $4::jsonb)`,
			[locals.user.id, id, clientAddress, JSON.stringify({ isCompleted: body.isCompleted })],
		);
		await client.query('COMMIT');
		return new Response(JSON.stringify({ isCompleted: updated.rows[0].isCompleted }), { headers: jsonHeaders });
	} catch (error) {
		await client.query('ROLLBACK').catch((rollbackError: unknown) => console.error('Failed to rollback knowledge item status update:', rollbackError));
		throw error;
	} finally {
		client.release();
	}
};

export const DELETE: APIRoute = async ({ params, request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return fail('Недопустимый источник запроса.', 403);
	if (locals.user?.role !== 'admin') return fail('Удалять записи базы знаний может только администратор.', 403);
	const id = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(id)) return fail('Некорректный идентификатор записи.', 400);

	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		const deleted = await client.query<{ id: string }>(
			`DELETE FROM department_knowledge_items
			 WHERE id = $1
			 RETURNING id::text`,
			[id],
		);
		if (!deleted.rowCount) {
			await client.query('ROLLBACK');
			return fail('Запись базы знаний не найдена.', 404);
		}
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
			 VALUES ($1, 'knowledge_item_deleted', 'knowledge_item', $2, 'success', $3)`,
			[locals.user.id, deleted.rows[0].id, clientAddress],
		);
		await client.query('COMMIT');
		return new Response(null, { status: 204 });
	} catch (error) {
		await client.query('ROLLBACK').catch((rollbackError: unknown) => console.error('Failed to rollback knowledge item deletion:', rollbackError));
		throw error;
	} finally {
		client.release();
	}
};
