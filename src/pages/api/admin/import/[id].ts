import { rm } from 'node:fs/promises';
import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../../lib/server/auth';
import { getPool } from '../../../../lib/server/db';
import { resolveStoredPath } from '../../../../lib/server/storage';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

export const DELETE: APIRoute = async ({ params, request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return new Response(JSON.stringify({ error: 'Недопустимый источник запроса.' }), { status: 403, headers: jsonHeaders });
	if (locals.user?.role !== 'admin') return new Response(JSON.stringify({ error: 'Импорт доступен только администратору.' }), { status: 403, headers: jsonHeaders });
	const batchId = params.id ?? '';
	if (!/^[a-f0-9-]{36}$/i.test(batchId)) return new Response(JSON.stringify({ error: 'Некорректный идентификатор импорта.' }), { status: 400, headers: jsonHeaders });

	const client = await getPool().connect();
	let transactionStarted = false;
	let stagedPaths: string[] = [];
	try {
		await client.query('BEGIN');
		transactionStarted = true;
		const batch = await client.query(
			"SELECT id FROM import_batches WHERE id = $1 AND user_id = $2 AND status = 'pending' FOR UPDATE",
			[batchId, locals.user.id],
		);
		if (!batch.rowCount) {
			await client.query('ROLLBACK');
			transactionStarted = false;
			return new Response(JSON.stringify({ error: 'Ожидающий импорт не найден.' }), { status: 404, headers: jsonHeaders });
		}
		const files = await client.query<{ staged_path: string | null }>(
			'SELECT DISTINCT staged_path FROM import_items WHERE batch_id = $1 AND staged_path IS NOT NULL',
			[batchId],
		);
		stagedPaths = files.rows.map((row) => row.staged_path!);
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
			 VALUES ($1, 'import_cancelled', 'import_batch', $2, 'success', $3)`,
			[locals.user.id, batchId, clientAddress],
		);
		await client.query('DELETE FROM import_batches WHERE id = $1', [batchId]);
		await client.query('COMMIT');
		transactionStarted = false;
		for (const storedPath of stagedPaths) {
			await rm(resolveStoredPath(storedPath), { force: true }).catch((error: unknown) => {
				console.error('Failed to clean up cancelled import staging file:', error);
			});
		}
		return new Response(null, { status: 204 });
	} catch (error) {
		if (transactionStarted) await client.query('ROLLBACK').catch((rollbackError: unknown) => console.error('Failed to rollback import cancellation:', rollbackError));
		throw error;
	} finally {
		client.release();
	}
};
