import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../lib/server/auth';
import { getPool } from '../../../lib/server/db';

export const DELETE: APIRoute = async ({ params, request, locals, clientAddress }) => {
	const headers = { 'content-type': 'application/json; charset=utf-8' };
	if (!assertSameOrigin(request)) {
		return new Response(JSON.stringify({ error: 'Недопустимый источник запроса.' }), { status: 403, headers });
	}
	if (locals.user?.role !== 'admin') {
		return new Response(JSON.stringify({ error: 'Удалять файлы может только администратор.' }), { status: 403, headers });
	}
	const fileId = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(fileId)) {
		return new Response(JSON.stringify({ error: 'Некорректный идентификатор файла.' }), { status: 400, headers });
	}

	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		const selected = await client.query<{ attachment_id: string; document_id: string }>(
			'SELECT attachment_id, document_id FROM document_files WHERE id = $1 AND NOT is_deleted FOR UPDATE',
			[fileId],
		);
		if (!selected.rowCount) {
			await client.query('ROLLBACK');
			return new Response(JSON.stringify({ error: 'Файл не найден.' }), { status: 404, headers });
		}
		const file = selected.rows[0];
		await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [file.attachment_id]);
		await client.query(
			'UPDATE document_files SET is_deleted = TRUE, is_current = FALSE WHERE attachment_id = $1',
			[file.attachment_id],
		);
		await client.query(
			'INSERT INTO document_history (document_id, user_id, action) VALUES ($1, $2, $3)',
			[file.document_id, locals.user.id, 'file_deleted'],
		);
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
			 VALUES ($1, 'file_deleted', 'file', $2, 'success', $3)`,
			[locals.user.id, fileId, clientAddress],
		);
		await client.query('COMMIT');
		return new Response(null, { status: 204 });
	} catch (error) {
		await client.query('ROLLBACK').catch((rollbackError: unknown) => {
			console.error('Failed to rollback file deletion:', rollbackError);
		});
		throw error;
	} finally {
		client.release();
	}
};
