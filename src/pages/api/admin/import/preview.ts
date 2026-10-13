import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../../lib/server/auth';
import { prepareImport } from '../../../../lib/server/import-manifest';
import { parseUpload, resolveStoredPath } from '../../../../lib/server/storage';
import { getPool } from '../../../../lib/server/db';
import type { PoolClient } from 'pg';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const extensions = ['csv', 'xlsx', 'zip'] as const;

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) {
		return new Response(JSON.stringify({ error: 'Недопустимый источник запроса.' }), { status: 403, headers: jsonHeaders });
	}
	if (locals.user?.role !== 'admin') {
		return new Response(JSON.stringify({ error: 'Импорт доступен только администратору.' }), { status: 403, headers: jsonHeaders });
	}

	let upload;
	try {
		upload = await parseUpload(request, extensions);
	} catch (error) {
		if (error instanceof Error && (
			error.message.startsWith('Недопустимый формат') ||
			error.message.startsWith('Размер запроса') ||
			error.message.startsWith('Содержимое файла') ||
			error.message.startsWith('Комментарий или тип файла')
		)) {
			return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeaders });
		}
		throw error;
	}

	const batchId = randomUUID();
	let prepared;
	try {
		prepared = await prepareImport(upload, batchId);
	} catch (error) {
		await rm(resolveStoredPath(upload.temporaryPath), { force: true });
		if (error instanceof Error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeaders });
		throw error;
	}
	await rm(resolveStoredPath(upload.temporaryPath), { force: true });
	if (!prepared.items.length || prepared.items.length > 1000) {
		await Promise.all(prepared.stagedFiles.map((file) => rm(resolveStoredPath(file), { force: true })));
		return new Response(JSON.stringify({ error: 'Импорт должен содержать от 1 до 1000 записей.' }), { status: 400, headers: jsonHeaders });
	}

	const pool = getPool();
	let client: PoolClient | undefined;
	let transactionStarted = false;
	const expiredStagedPaths: string[] = [];
	try {
		client = await pool.connect();
		await client.query('BEGIN');
		transactionStarted = true;
		const expired = await client.query<{ batch_id: string; staged_path: string | null }>(
			`SELECT b.id AS batch_id, i.staged_path
			 FROM import_batches b
			 LEFT JOIN import_items i ON i.batch_id = b.id
			 WHERE b.status = 'pending' AND b.expires_at <= NOW()
			 FOR UPDATE OF b SKIP LOCKED`,
		);
		const expiredBatchIds = [...new Set(expired.rows.map((row) => row.batch_id))];
		expiredStagedPaths.push(...new Set(expired.rows.map((row) => row.staged_path).filter((file): file is string => Boolean(file))));
		if (expiredBatchIds.length) {
			await client.query('DELETE FROM import_batches WHERE id = ANY($1::uuid[])', [expiredBatchIds]);
		}
		await client.query(
			'INSERT INTO import_batches (id, user_id, source_name) VALUES ($1, $2, $3)',
			[batchId, locals.user.id, upload.originalName],
		);
		const responseItems = [];
		for (let index = 0; index < prepared.items.length; index++) {
			const item = prepared.items[index];
			const duplicates = item.error ? { rows: [] } : await client.query(
				`SELECT id, title, doc_number AS number
				 FROM documents
				 WHERE NOT is_deleted
				   AND (($1 <> '' AND lower(doc_number) = lower($1))
				     OR ($2::date IS NOT NULL AND doc_date = $2::date AND lower(title) = lower($3)))
				 ORDER BY updated_at DESC LIMIT 5`,
				[item.number, item.date, item.title],
			);
			const documentData = {
				title: item.title, number: item.number, date: item.date,
				effectiveDate: item.effectiveDate, expiryDate: item.expiryDate,
				type: item.type, status: item.status, department: item.department,
				description: item.description, tags: item.tags, fileKind: item.fileKind,
			};
			const storedItem = await client.query<{ id: string }>(
				`INSERT INTO import_items
				   (batch_id, item_number, document_data, file_name, staged_path, file_sha256, duplicate_documents, error)
				 VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb, $8)
				 RETURNING id`,
				[
					batchId, index + 1, JSON.stringify(documentData), item.fileName,
					item.stagedPath, item.sha256, JSON.stringify(duplicates.rows), item.error,
				],
			);
			responseItems.push({
				id: storedItem.rows[0].id,
				...documentData,
				fileName: item.fileName,
				sha256: item.sha256,
				duplicates: duplicates.rows,
				error: item.error,
				defaultAction: item.error ? 'skip' : duplicates.rowCount ? 'skip' : 'create',
			});
		}
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address, details)
			 VALUES ($1, 'import_preview_created', 'import_batch', $2, 'success', $3, $4::jsonb)`,
			[locals.user.id, batchId, clientAddress, JSON.stringify({ items: responseItems.length, source: upload.originalName })],
		);
		await client.query('COMMIT');
		transactionStarted = false;
		for (const storedPath of expiredStagedPaths) {
			await rm(resolveStoredPath(storedPath), { force: true }).catch((error: unknown) => {
				console.error('Failed to clean up expired import staging file:', error);
			});
		}
		return new Response(JSON.stringify({ batchId, sourceName: upload.originalName, items: responseItems }), {
			status: 201,
			headers: jsonHeaders,
		});
	} catch (error) {
		if (transactionStarted) await client.query('ROLLBACK').catch((rollbackError: unknown) => {
			console.error('Failed to rollback import preview:', rollbackError);
		});
		await Promise.all(prepared.stagedFiles.map((file) => rm(resolveStoredPath(file), { force: true })));
		throw error;
	} finally {
		client?.release();
	}
};
