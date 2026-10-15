import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../lib/server/auth';
import { getPool } from '../../../lib/server/db';

function fail(error: string, status: number): Response {
	return new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

export const DELETE: APIRoute = async ({ params, request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return fail('Недопустимый источник запроса.', 403);
	if (locals.user?.role !== 'admin') return fail('Удалять шаблоны может только администратор.', 403);
	const id = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(id)) return fail('Некорректный идентификатор шаблона.', 400);

	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		const selected = await client.query(
			'SELECT id FROM document_templates WHERE id = $1 AND NOT is_deleted FOR UPDATE',
			[id],
		);
		if (!selected.rowCount) {
			await client.query('ROLLBACK');
			return fail('Шаблон не найден.', 404);
		}
		await client.query('UPDATE document_templates SET is_deleted = TRUE WHERE id = $1', [id]);
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
			 VALUES ($1, 'template_deleted', 'template', $2, 'success', $3)`,
			[locals.user.id, id, clientAddress],
		);
		await client.query('COMMIT');
		return new Response(null, { status: 204 });
	} catch (error) {
		await client.query('ROLLBACK').catch((rollbackError: unknown) => console.error('Failed to rollback template deletion:', rollbackError));
		throw error;
	} finally {
		client.release();
	}
};
