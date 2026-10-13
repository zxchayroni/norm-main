import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../../lib/server/auth';
import { saveNewVersion } from '../../../../lib/server/files';
import { parseUpload, removeStoredPath } from '../../../../lib/server/storage';
import { getPool } from '../../../../lib/server/db';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const knownUploadErrors = new Set([
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
	'Выберите действующий тип файла из справочника.',
]);

export const GET: APIRoute = async ({ params, locals }) => {
	if (locals.user?.role === 'reader') {
		return new Response(JSON.stringify({ error: 'Просматривать историю версий могут редакторы и администраторы.' }), {
			status: 403,
			headers: jsonHeaders,
		});
	}
	const fileId = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(fileId)) {
		return new Response(JSON.stringify({ error: 'Некорректный идентификатор файла.' }), { status: 400, headers: jsonHeaders });
	}

	const versions = await getPool().query(
		`SELECT f.id, f.original_name AS name, f.version, f.file_size AS size, f.sha256,
		        f.comment, f.uploaded_at AS "uploadedAt", u.full_name AS "uploadedBy", f.is_current AS "isCurrent"
		 FROM document_files selected
		 JOIN documents d ON d.id = selected.document_id
		 JOIN document_files f ON f.attachment_id = selected.attachment_id
		 LEFT JOIN users u ON u.id = f.uploaded_by
		 WHERE selected.id = $1 AND NOT selected.is_deleted
		   AND NOT d.is_deleted AND NOT f.is_deleted
		   AND ($2 = 'admin' OR d.access_level = 'organization')
		 ORDER BY f.version DESC`,
		[fileId, locals.user?.role ?? 'reader'],
	);
	if (!versions.rowCount) {
		return new Response(JSON.stringify({ error: 'Файл не найден.' }), { status: 404, headers: jsonHeaders });
	}
	return new Response(JSON.stringify({ versions: versions.rows }), { headers: jsonHeaders });
};

export const POST: APIRoute = async ({ params, request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) {
		return new Response(JSON.stringify({ error: 'Недопустимый источник запроса.' }), { status: 403, headers: jsonHeaders });
	}
	if (locals.user?.role === 'reader') {
		return new Response(JSON.stringify({ error: 'Недостаточно прав для загрузки версии.' }), { status: 403, headers: jsonHeaders });
	}
	const fileId = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(fileId)) {
		return new Response(JSON.stringify({ error: 'Некорректный идентификатор файла.' }), { status: 400, headers: jsonHeaders });
	}

	let upload;
	try {
		upload = await parseUpload(request);
	} catch (error) {
		if (error instanceof Error && (
			knownUploadErrors.has(error.message) ||
			error.message.startsWith('Недопустимый формат') ||
			error.message === 'Содержимое файла не соответствует расширению.'
		)) {
			return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeaders });
		}
		throw error;
	}

	try {
		const file = await saveNewVersion(fileId, locals.user!.id, locals.user!.role, upload, clientAddress);
		return new Response(JSON.stringify({
			id: file.id,
			name: file.original_name,
			version: file.version,
			size: Number(file.file_size),
			sha256: file.sha256,
		}), { status: 201, headers: jsonHeaders });
	} catch (error) {
		await removeStoredPath(upload.temporaryPath).catch((cleanupError: unknown) => {
			console.error('Failed to clean up an unsuccessful version upload:', cleanupError);
		});
		if (error instanceof Error && error.message === 'Файл не найден или недоступен.') {
			return new Response(JSON.stringify({ error: error.message }), { status: 404, headers: jsonHeaders });
		}
		if (error instanceof Error && (error.message.startsWith('Выберите действующий') || error.message.startsWith('Новая версия'))) {
			return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeaders });
		}
		throw error;
	}
};
