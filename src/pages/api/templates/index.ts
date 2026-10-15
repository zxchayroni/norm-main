import type { APIRoute } from 'astro';
import type { PoolClient } from 'pg';
import { assertSameOrigin } from '../../../lib/server/auth';
import { getPool } from '../../../lib/server/db';
import { moveUploadIntoStorage, removeStoredPath, parseUpload } from '../../../lib/server/storage';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const clientUploadErrors = new Set([
	'Ожидается multipart-загрузка файла.',
	'Размер запроса превышает допустимые 100 МБ на файл.',
	'В запросе отсутствует тело с файлом.',
	'Некорректное имя файла.',
	'Слишком длинное значение поля загрузки.',
	'За один запрос можно загрузить только один файл.',
	'Слишком много параметров загрузки.',
	'Файл должен передаваться в поле "file".',
	'Недопустимый формат. Разрешены только DOCX, XLSX и PDF.',
	'Файл превышает допустимый размер 100 МБ.',
	'Содержимое файла не соответствует расширению. Поддерживаются DOCX, XLSX и PDF.',
	'В запросе отсутствует файл.',
	'Комментарий или тип файла слишком длинный.',
]);

function fail(error: string, status: number): Response {
	return new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });
}

export const GET: APIRoute = async ({ locals }) => {
	const templates = await getPool().query(
		`SELECT t.id, t.original_name AS "originalName", t.file_size AS size,
		        t.uploaded_at AS "uploadedAt",
		        COALESCE(NULLIF(u.full_name, ''), u.username, 'Неизвестный пользователь') AS "uploadedBy"
		 FROM document_templates t
		 LEFT JOIN users u ON u.id = t.uploaded_by
		 WHERE NOT t.is_deleted
		 ORDER BY t.uploaded_at DESC, t.id DESC`,
	);
	return new Response(JSON.stringify({ templates: templates.rows, canDelete: locals.user?.role === 'admin' }), { headers: jsonHeaders });
};

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return fail('Недопустимый источник запроса.', 403);
	if (!locals.user || locals.user.role === 'reader') return fail('Недостаточно прав для добавления шаблонов.', 403);

	let upload;
	try {
		upload = await parseUpload(request);
	} catch (error) {
		if (error instanceof Error && (
			clientUploadErrors.has(error.message) ||
			error.message.startsWith('Недопустимый формат') ||
			error.message === 'Содержимое файла не соответствует расширению.'
		)) return fail(error.message, 400);
		throw error;
	}

	let storedPath: string | undefined;
	let client: PoolClient | undefined;
	let transactionStarted = false;
	try {
		client = await getPool().connect();
		storedPath = await moveUploadIntoStorage(upload);
		await client.query('BEGIN');
		transactionStarted = true;
		const inserted = await client.query<{ id: string }>(
			`INSERT INTO document_templates
			   (original_name, stored_path, extension, mime_type, file_size, sha256, uploaded_by)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 RETURNING id`,
			[upload.originalName, storedPath, upload.extension, upload.mimeType, upload.fileSize, upload.sha256, locals.user.id],
		);
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
			 VALUES ($1, 'template_uploaded', 'template', $2, 'success', $3)`,
			[locals.user.id, inserted.rows[0].id, clientAddress],
		);
		await client.query('COMMIT');
		transactionStarted = false;
		return new Response(JSON.stringify({ id: inserted.rows[0].id, originalName: upload.originalName }), {
			status: 201,
			headers: jsonHeaders,
		});
	} catch (error) {
		if (transactionStarted && client) {
			await client.query('ROLLBACK').catch((rollbackError: unknown) => console.error('Failed to rollback template upload:', rollbackError));
		}
		try {
			await removeStoredPath(storedPath ?? upload.temporaryPath);
		} catch (cleanupError) {
			console.error('Failed to clean up an unsuccessful template upload:', cleanupError);
		}
		throw error;
	} finally {
		client?.release();
	}
};
