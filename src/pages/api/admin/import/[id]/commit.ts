import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../../../lib/server/auth';
import { getPool } from '../../../../../lib/server/db';
import { removeStoredPath, resolveStoredPath } from '../../../../../lib/server/storage';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function response(error: string, status: number): Response {
	return new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });
}

interface ImportDocument {
	title: string;
	number: string;
	date: string | null;
	effectiveDate: string | null;
	expiryDate: string | null;
	type: string;
	status: string;
	department: string;
	description: string;
	tags: string[];
	fileKind: string;
}

interface ImportItem {
	id: string;
	item_number: number;
	document_data: ImportDocument;
	file_name: string | null;
	staged_path: string | null;
	file_sha256: string | null;
	error: string | null;
}

export const POST: APIRoute = async ({ params, request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return response('Недопустимый источник запроса.', 403);
	if (locals.user?.role !== 'admin') return response('Импорт доступен только администратору.', 403);
	const batchId = params.id ?? '';
	if (!/^[a-f0-9-]{36}$/i.test(batchId)) return response('Некорректный идентификатор импорта.', 400);

	let body: unknown;
	try { body = await request.json(); } catch { return response('Некорректный формат запроса.', 400); }
	if (!body || typeof body !== 'object' || Array.isArray(body) || !('items' in body) || !Array.isArray(body.items)) {
		return response('Укажите действия для записей импорта.', 400);
	}
	const actions = body.items;
	if (actions.length > 1000 || actions.some((item) =>
		!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string' ||
		!('action' in item) || !['skip', 'create', 'attach'].includes(String(item.action)) ||
		('targetDocumentId' in item && item.targetDocumentId !== null && typeof item.targetDocumentId !== 'string')
	)) return response('Некорректные действия импорта.', 400);

	const client = await getPool().connect();
	let transactionStarted = false;
	const createdPaths: string[] = [];
	const stagedPaths: string[] = [];
	const abort = async (message: string, status: number): Promise<Response> => {
		if (transactionStarted) {
			await client.query('ROLLBACK');
			transactionStarted = false;
		}
		for (const storedPath of createdPaths) {
			await removeStoredPath(storedPath).catch((error: unknown) => {
				console.error('Failed to clean up a file after aborted import:', error);
			});
		}
		return response(message, status);
	};
	try {
		await client.query('BEGIN');
		transactionStarted = true;
		const batch = await client.query(
			`SELECT id FROM import_batches
			 WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > NOW()
			 FOR UPDATE`,
			[batchId, locals.user.id],
		);
		if (!batch.rowCount) {
			await client.query('ROLLBACK');
			transactionStarted = false;
			return response('Импорт не найден, уже завершён или истёк.', 404);
		}
		const itemsResult = await client.query<ImportItem>(
			'SELECT id, item_number, document_data, file_name, staged_path, file_sha256, error FROM import_items WHERE batch_id = $1 ORDER BY item_number FOR UPDATE',
			[batchId],
		);
		stagedPaths.push(...new Set(itemsResult.rows.map((item) => item.staged_path).filter((value): value is string => Boolean(value))));
		const itemById = new Map(itemsResult.rows.map((item) => [item.id, item]));
		const actionIds = new Set(actions.map((item: { id: string }) => item.id));
		if (actions.length !== itemById.size || actionIds.size !== itemById.size || [...itemById.keys()].some((id) => !actionIds.has(id))) {
			return await abort('Для каждой строки импорта требуется ровно одно действие.', 400);
		}

		const outcomes: Array<{ itemId: string; action: string; documentId?: string; fileId?: string }> = [];
		for (const selected of actions as Array<{ id: string; action: 'skip' | 'create' | 'attach'; targetDocumentId?: string }>) {
			const item = itemById.get(selected.id)!;
			if (item.error && selected.action !== 'skip') {
				return await abort(`Строка ${item.item_number}: ${item.error}`, 400);
			}
			if (selected.action === 'skip') {
				await client.query("UPDATE import_items SET action = 'skip' WHERE id = $1", [item.id]);
				outcomes.push({ itemId: item.id, action: 'skip' });
				continue;
			}
			if (selected.action === 'attach' && (!item.staged_path || !item.file_name || !item.file_sha256)) {
				return await abort(`Строка ${item.item_number}: для действия «добавить файл» нужен файл во вложении.`, 400);
			}

			let documentId: string;
			if (selected.action === 'attach') {
				const target = selected.targetDocumentId;
				if (!target || !/^[1-9]\d{0,17}$/.test(target)) return await abort(`Строка ${item.item_number}: выберите документ для вложения файла.`, 400);
				const targetResult = await client.query<{ id: string }>(
					'SELECT id FROM documents WHERE id = $1 AND NOT is_deleted',
					[target],
				);
				if (!targetResult.rowCount) return await abort(`Строка ${item.item_number}: документ для вложения не найден.`, 404);
				documentId = target;
			} else {
				const data = item.document_data;
				const [type, status, department, fileKind] = await Promise.all([
					client.query<{ id: string }>("SELECT id FROM dictionaries WHERE type = 'doc_type' AND name = $1 AND is_active", [data.type]),
					client.query<{ id: string }>("SELECT id FROM dictionaries WHERE type = 'status' AND name = $1 AND is_active", [data.status]),
					data.department
						? client.query<{ id: string }>("SELECT id FROM dictionaries WHERE type = 'department' AND name = $1 AND is_active", [data.department])
						: Promise.resolve({ rows: [], rowCount: 0 }),
					item.staged_path
						? client.query<{ id: string }>("SELECT id FROM dictionaries WHERE type = 'file_kind' AND name = $1 AND is_active", [data.fileKind])
						: Promise.resolve({ rows: [], rowCount: 0 }),
				]);
				if (!type.rowCount || !status.rowCount || (data.department && !department.rowCount) || (item.staged_path && !fileKind.rowCount)) {
					return await abort(`Строка ${item.item_number}: вид, статус, подразделение или тип файла не найден в справочниках.`, 400);
				}
				const inserted = await client.query<{ id: string }>(
					`INSERT INTO documents
					   (title, doc_type_id, doc_number, doc_date, effective_date, expiry_date, status_id,
					    description, department_id, owner_user_id, created_by, updated_by)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10)
					 RETURNING id`,
					[
						data.title, type.rows[0].id, data.number, data.date, data.effectiveDate,
						data.expiryDate, status.rows[0].id, data.description,
						department.rows[0]?.id ?? null, locals.user.id,
					],
				);
				documentId = inserted.rows[0].id;
				for (const tag of data.tags) {
					const tagResult = await client.query<{ id: string }>(
						'INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
						[tag],
					);
					await client.query('INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2)', [documentId, tagResult.rows[0].id]);
				}
			}

			let fileId: string | undefined;
			if (item.staged_path && item.file_name && item.file_sha256) {
				const extension = path.extname(item.file_name).slice(1).toLowerCase();
				const relativePath = path.join(item.file_sha256.slice(0, 2), `${randomUUID()}.${extension}`);
				const absolutePath = resolveStoredPath(relativePath);
				await mkdir(path.dirname(absolutePath), { recursive: true });
				createdPaths.push(relativePath);
				await copyFile(resolveStoredPath(item.staged_path), absolutePath);
				const fileKind = await client.query<{ id: string }>(
					"SELECT id FROM dictionaries WHERE type = 'file_kind' AND name = $1 AND is_active",
					[item.document_data.fileKind],
				);
				if (!fileKind.rowCount) return await abort(`Строка ${item.item_number}: тип файла не найден в справочнике.`, 400);
				const fileInfo = await stat(absolutePath);
				const mimeType = extension === 'pdf'
					? 'application/pdf'
					: extension === 'docx'
						? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
						: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
				const file = await client.query<{ id: string }>(
					`INSERT INTO document_files
					   (document_id, attachment_id, original_name, stored_path, extension, mime_type,
					    file_size, sha256, file_kind_id, version, is_current, uploaded_by)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, TRUE, $10)
					 RETURNING id`,
					[
					documentId, randomUUID(), item.file_name, relativePath, extension, mimeType,
					fileInfo.size, item.file_sha256, fileKind.rows[0].id,
					locals.user.id,
					],
				);
				fileId = file.rows[0].id;
			}

			await client.query(
				'INSERT INTO document_history (document_id, user_id, action) VALUES ($1, $2, $3)',
				[documentId, locals.user.id, selected.action === 'attach' ? 'file_imported' : 'created_by_import'],
			);
			await client.query(
				'UPDATE import_items SET action = $2, target_document_id = $3 WHERE id = $1',
				[item.id, selected.action, documentId],
			);
			outcomes.push({ itemId: item.id, action: selected.action, documentId, ...(fileId ? { fileId } : {}) });
		}

		await client.query(
			"UPDATE import_batches SET status = 'committed', committed_at = NOW() WHERE id = $1",
			[batchId],
		);
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address, details)
			 VALUES ($1, 'import_committed', 'import_batch', $2, 'success', $3, $4::jsonb)`,
			[locals.user.id, batchId, clientAddress, JSON.stringify({ outcomes })],
		);
		await client.query('COMMIT');
		transactionStarted = false;
		for (const stagedPath of new Set(stagedPaths)) {
			await rm(resolveStoredPath(stagedPath), { force: true }).catch((cleanupError: unknown) => {
				console.error('Failed to clean up a committed import staging file:', cleanupError);
			});
		}
		return new Response(JSON.stringify({ batchId, outcomes }), { headers: jsonHeaders });
	} catch (error) {
		if (transactionStarted) await client.query('ROLLBACK').catch((rollbackError: unknown) => {
			console.error('Failed to rollback import commit:', rollbackError);
		});
		for (const storedPath of createdPaths) await removeStoredPath(storedPath).catch((cleanupError: unknown) => {
			console.error('Failed to remove a file from unsuccessful import:', cleanupError);
		});
		throw error;
	} finally {
		client.release();
	}
};
