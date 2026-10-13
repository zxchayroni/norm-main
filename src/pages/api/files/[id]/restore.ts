import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../../lib/server/auth';
import { getPool } from '../../../../lib/server/db';
import { removeStoredPath, resolveStoredPath, storageRoot } from '../../../../lib/server/storage';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

export const POST: APIRoute = async ({ params, request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) {
		return new Response(JSON.stringify({ error: 'Недопустимый источник запроса.' }), { status: 403, headers: jsonHeaders });
	}
	if (locals.user?.role === 'reader') {
		return new Response(JSON.stringify({ error: 'Недостаточно прав для восстановления версии.' }), { status: 403, headers: jsonHeaders });
	}
	const versionId = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(versionId)) {
		return new Response(JSON.stringify({ error: 'Некорректный идентификатор версии.' }), { status: 400, headers: jsonHeaders });
	}

	const client = await getPool().connect();
	let storedPath: string | undefined;
	let transactionStarted = false;
	try {
		await client.query('BEGIN');
		transactionStarted = true;
		const selected = await client.query<{
			id: string; document_id: string; attachment_id: string; original_name: string;
			stored_path: string; extension: string; mime_type: string; file_size: string;
			sha256: string; file_kind_id: string | null; version: number; access_level: string;
		}>(
			`SELECT f.*, d.access_level
			 FROM document_files f
			 JOIN documents d ON d.id = f.document_id
			 WHERE f.id = $1 AND NOT f.is_deleted AND NOT d.is_deleted
			   AND ($2 = 'admin' OR d.access_level = 'organization')
			 FOR UPDATE OF f`,
			[versionId, locals.user?.role ?? 'reader'],
		);
		if (!selected.rowCount) {
			await client.query('ROLLBACK');
			return new Response(JSON.stringify({ error: 'Версия не найдена.' }), { status: 404, headers: jsonHeaders });
		}
		const oldVersion = selected.rows[0];
		await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [oldVersion.attachment_id]);
		storedPath = path.join(oldVersion.sha256.slice(0, 2), `${randomUUID()}.${oldVersion.extension}`);
		const destination = resolveStoredPath(storedPath);
		await mkdir(path.dirname(destination), { recursive: true });
		await copyFile(resolveStoredPath(oldVersion.stored_path), destination);

		const maximum = await client.query<{ version: number }>(
			'SELECT COALESCE(MAX(version), 0)::integer AS version FROM document_files WHERE attachment_id = $1',
			[oldVersion.attachment_id],
		);
		const nextVersion = maximum.rows[0].version + 1;
		await client.query(
			'UPDATE document_files SET is_current = FALSE WHERE attachment_id = $1 AND is_current AND NOT is_deleted',
			[oldVersion.attachment_id],
		);
		const restored = await client.query<{ id: string }>(
			`INSERT INTO document_files
			   (document_id, attachment_id, original_name, stored_path, extension, mime_type, file_size,
			    sha256, file_kind_id, version, is_current, comment, uploaded_by)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11, $12)
			 RETURNING id`,
			[
				oldVersion.document_id, oldVersion.attachment_id, oldVersion.original_name, storedPath,
				oldVersion.extension, oldVersion.mime_type, oldVersion.file_size, oldVersion.sha256,
				oldVersion.file_kind_id, nextVersion, `Восстановлено из версии ${oldVersion.version}`, locals.user?.id,
			],
		);
		await client.query(
			`INSERT INTO document_history (document_id, user_id, action, field_name, old_value, new_value)
			 VALUES ($1, $2, 'file_version_restored', 'version', $3, $4)`,
			[oldVersion.document_id, locals.user?.id, String(oldVersion.version), String(nextVersion)],
		);
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
			 VALUES ($1, 'file_version_restored', 'file', $2, 'success', $3)`,
			[locals.user?.id, restored.rows[0].id, clientAddress],
		);
		await client.query('COMMIT');
		return new Response(JSON.stringify({ id: restored.rows[0].id, version: nextVersion }), { status: 201, headers: jsonHeaders });
	} catch (error) {
		if (transactionStarted) await client.query('ROLLBACK').catch((rollbackError: unknown) => {
			console.error('Failed to rollback version restore:', rollbackError);
		});
		if (storedPath) await removeStoredPath(storedPath);
		throw error;
	} finally {
		client.release();
	}
};
