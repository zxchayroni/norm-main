import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../../lib/server/auth';
import { saveNewAttachment } from '../../../../lib/server/files';
import { parseUpload, removeStoredPath } from '../../../../lib/server/storage';
import { getPool } from '../../../../lib/server/db';

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
	'Выберите действующий тип файла из справочника.',
]);

export const POST: APIRoute = async ({ params, request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) {
		return new Response(JSON.stringify({ error: 'Недопустимый источник запроса.' }), { status: 403, headers: jsonHeaders });
	}
	if (locals.user?.role === 'reader') {
		return new Response(JSON.stringify({ error: 'Недостаточно прав для загрузки файла.' }), { status: 403, headers: jsonHeaders });
	}
	const documentId = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(documentId)) {
		return new Response(JSON.stringify({ error: 'Некорректный идентификатор документа.' }), { status: 400, headers: jsonHeaders });
	}

	const document = await getPool().query(
		`SELECT id FROM documents
		 WHERE id = $1 AND NOT is_deleted AND ($2 = 'admin' OR access_level = 'organization')`,
		[documentId, locals.user?.role],
	);
	if (!document.rowCount) {
		return new Response(JSON.stringify({ error: 'Документ не найден.' }), { status: 404, headers: jsonHeaders });
	}

	let upload;
	try {
		upload = await parseUpload(request);
	} catch (error) {
		if (error instanceof Error && (
			clientUploadErrors.has(error.message) ||
			error.message.startsWith('Недопустимый формат') ||
			error.message === 'Содержимое файла не соответствует расширению.'
		)) {
			return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeaders });
		}
		throw error;
	}

	try {
		const file = await saveNewAttachment(documentId, locals.user!.id, locals.user!.role, upload, clientAddress);
		return new Response(JSON.stringify({
			id: file.id,
			name: file.original_name,
			version: file.version,
			size: Number(file.file_size),
			sha256: file.sha256,
		}), { status: 201, headers: jsonHeaders });
	} catch (error) {
		await removeStoredPath(upload.temporaryPath).catch((cleanupError: unknown) => {
			console.error('Failed to clean up an unsuccessful file upload:', cleanupError);
		});
		if (error instanceof Error && error.message === 'Документ не найден или недоступен.') {
			return new Response(JSON.stringify({ error: error.message }), { status: 404, headers: jsonHeaders });
		}
		throw error;
	}
};
