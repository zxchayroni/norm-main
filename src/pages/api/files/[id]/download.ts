import { createReadStream } from 'node:fs';
import type { APIRoute } from 'astro';
import { Readable } from 'node:stream';
import { getPool } from '../../../../lib/server/db';
import { resolveStoredPath } from '../../../../lib/server/storage';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function contentDisposition(name: string): string {
	const safeAscii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	const encoded = encodeURIComponent(name).replace(/['()*]/g, (character) =>
		`%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}

export const GET: APIRoute = async ({ params, locals, clientAddress }) => {
	const fileId = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(fileId)) {
		return new Response(JSON.stringify({ error: 'Некорректный идентификатор файла.' }), { status: 400, headers: jsonHeaders });
	}

	const result = await getPool().query<{
		id: string;
		document_id: string;
		original_name: string;
		stored_path: string;
		mime_type: string;
		file_size: string;
		is_current: boolean;
		access_level: string;
	}>(
		`SELECT f.id, f.document_id, f.original_name, f.stored_path, f.mime_type, f.file_size,
		        f.is_current, d.access_level
		 FROM document_files f
		 JOIN documents d ON d.id = f.document_id
		 WHERE f.id = $1 AND NOT f.is_deleted AND NOT d.is_deleted
		   AND ($2 = 'admin' OR d.access_level = 'organization')
		   AND ($2 = 'admin' OR f.is_current = TRUE)`,
		[fileId, locals.user?.role ?? 'reader'],
	);
	const file = result.rows[0];
	if (!file) return new Response(JSON.stringify({ error: 'Файл не найден.' }), { status: 404, headers: jsonHeaders });

	const absolutePath = resolveStoredPath(file.stored_path);
	const stream = createReadStream(absolutePath);
	stream.on('error', (error) => console.error(`Unable to stream archived file ${file.id}:`, error));

	await getPool().query(
		`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
		 VALUES ($1, 'file_downloaded', 'file', $2, 'success', $3)`,
		[locals.user?.id, file.id, clientAddress],
	);

	return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
		headers: {
			'content-type': file.mime_type,
			'content-length': file.file_size,
			'content-disposition': contentDisposition(file.original_name),
			'cache-control': 'private, no-store',
			'x-content-type-options': 'nosniff',
		},
	});
};
