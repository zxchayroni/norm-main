import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ParsedUpload } from './storage';
import { getPool } from './db';
import { moveUploadIntoStorage, removeStoredPath } from './storage';

export interface StoredFile {
	id: string;
	document_id: string;
	attachment_id: string;
	original_name: string;
	stored_path: string;
	extension: string;
	mime_type: string;
	file_size: string;
	sha256: string;
	file_kind_id: string | null;
	version: number;
	is_current: boolean;
	comment: string | null;
	uploaded_by: string | null;
	uploaded_at: Date;
}

export async function findFileKindId(client: PoolClient, name: string): Promise<string> {
	const result = await client.query<{ id: string }>(
		"SELECT id FROM dictionaries WHERE type = 'file_kind' AND name = $1 AND is_active",
		[name],
	);
	if (!result.rowCount) throw new Error('Выберите действующий тип файла из справочника.');
	return result.rows[0].id;
}

export async function saveNewAttachment(
	documentId: string,
	userId: string,
	userRole: 'admin' | 'editor' | 'reader',
	upload: ParsedUpload,
	clientAddress: string,
): Promise<StoredFile> {
	const pool = getPool();
	const client = await pool.connect();
	let storedPath: string | undefined;
	let transactionStarted = false;
	try {
		const fileKindId = await findFileKindId(client, upload.fileKind);
		storedPath = await moveUploadIntoStorage(upload);
		await client.query('BEGIN');
		transactionStarted = true;
		const document = await client.query(
			`SELECT id FROM documents
			 WHERE id = $1 AND NOT is_deleted
			   AND ($2 = 'admin' OR access_level = 'organization')
			 FOR UPDATE`,
			[documentId, userRole],
		);
		if (!document.rowCount) throw new Error('Документ не найден или недоступен.');
		const result = await client.query<StoredFile>(
			`INSERT INTO document_files
			   (document_id, attachment_id, original_name, stored_path, extension, mime_type, file_size,
			    sha256, file_kind_id, version, is_current, comment, uploaded_by)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, TRUE, $10, $11)
			 RETURNING *`,
			[
				documentId, randomUUID(), upload.originalName, storedPath, upload.extension, upload.mimeType,
				upload.fileSize, upload.sha256, fileKindId, upload.comment || null, userId,
			],
		);
		await client.query(
			'INSERT INTO document_history (document_id, user_id, action, field_name, new_value) VALUES ($1, $2, $3, $4, $5)',
			[documentId, userId, 'file_uploaded', 'file', upload.originalName],
		);
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
			 VALUES ($1, 'file_uploaded', 'file', $2, 'success', $3)`,
			[userId, result.rows[0].id, clientAddress],
		);
		await client.query('COMMIT');
		return result.rows[0];
	} catch (error) {
		if (transactionStarted) await client.query('ROLLBACK');
		if (storedPath) await removeStoredPath(storedPath);
		throw error;
	} finally {
		client.release();
	}
}

export async function saveNewVersion(
	previousFileId: string,
	userId: string,
	userRole: 'admin' | 'editor' | 'reader',
	upload: ParsedUpload,
	clientAddress: string,
): Promise<StoredFile> {
	const pool = getPool();
	const client = await pool.connect();
	let storedPath: string | undefined;
	let transactionStarted = false;
	try {
		await client.query('BEGIN');
		transactionStarted = true;
		const previous = await client.query<StoredFile>(
			`SELECT f.*
			 FROM document_files f
			 JOIN documents d ON d.id = f.document_id
			 WHERE f.id = $1 AND NOT f.is_deleted AND NOT d.is_deleted
			   AND ($2 = 'admin' OR d.access_level = 'organization')
			 FOR UPDATE OF f, d`,
			[previousFileId, userRole],
		);
		if (!previous.rowCount) throw new Error('Файл не найден или недоступен.');
		const oldFile = previous.rows[0];
		await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [oldFile.attachment_id]);
		const fileKindId = await findFileKindId(client, upload.fileKind);
		if (upload.extension !== oldFile.extension) throw new Error('Новая версия должна иметь тот же формат файла.');

		storedPath = await moveUploadIntoStorage(upload);
		const maxVersion = await client.query<{ version: number }>(
			'SELECT COALESCE(MAX(version), 0)::integer AS version FROM document_files WHERE attachment_id = $1',
			[oldFile.attachment_id],
		);
		const nextVersion = maxVersion.rows[0].version + 1;
		await client.query(
			'UPDATE document_files SET is_current = FALSE WHERE attachment_id = $1 AND is_current AND NOT is_deleted',
			[oldFile.attachment_id],
		);
		const result = await client.query<StoredFile>(
			`INSERT INTO document_files
			   (document_id, attachment_id, original_name, stored_path, extension, mime_type, file_size,
			    sha256, file_kind_id, version, is_current, comment, uploaded_by)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11, $12)
			 RETURNING *`,
			[
				oldFile.document_id, oldFile.attachment_id, upload.originalName, storedPath, upload.extension,
				upload.mimeType, upload.fileSize, upload.sha256, fileKindId, nextVersion,
				upload.comment || null, userId,
			],
		);
		await client.query(
			'INSERT INTO document_history (document_id, user_id, action, field_name, old_value, new_value) VALUES ($1, $2, $3, $4, $5, $6)',
			[oldFile.document_id, userId, 'file_version_created', 'version', String(oldFile.version), String(nextVersion)],
		);
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
			 VALUES ($1, 'file_version_created', 'file', $2, 'success', $3)`,
			[userId, result.rows[0].id, clientAddress],
		);
		await client.query('COMMIT');
		return result.rows[0];
	} catch (error) {
		if (transactionStarted) await client.query('ROLLBACK');
		if (storedPath) await removeStoredPath(storedPath);
		throw error;
	} finally {
		client.release();
	}
}
