import { createReadStream } from 'node:fs';
import type { APIRoute } from 'astro';
import { Readable } from 'node:stream';
import { getPool } from '../../../../lib/server/db';
import { resolveStoredPath } from '../../../../lib/server/storage';

function contentDisposition(name: string): string {
	const safeAscii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	const encoded = encodeURIComponent(name).replace(/['()*]/g, (character) =>
		`%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}

export const GET: APIRoute = async ({ params, locals, clientAddress }) => {
	const id = params.id ?? '';
	const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
	if (!/^[1-9]\d{0,17}$/.test(id)) {
		return new Response(JSON.stringify({ error: 'Некорректный идентификатор шаблона.' }), { status: 400, headers: jsonHeaders });
	}
	const result = await getPool().query<{
		id: string;
		original_name: string;
		stored_path: string;
		mime_type: string;
		file_size: string;
	}>(
		`SELECT id, original_name, stored_path, mime_type, file_size
		 FROM document_templates WHERE id = $1 AND NOT is_deleted`,
		[id],
	);
	const template = result.rows[0];
	if (!template) return new Response(JSON.stringify({ error: 'Шаблон не найден.' }), { status: 404, headers: jsonHeaders });

	const stream = createReadStream(resolveStoredPath(template.stored_path));
	stream.on('error', (error) => console.error(`Unable to stream document template ${template.id}:`, error));
	await getPool().query(
		`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
		 VALUES ($1, 'template_downloaded', 'template', $2, 'success', $3)`,
		[locals.user?.id, template.id, clientAddress],
	);
	return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
		headers: {
			'content-type': template.mime_type,
			'content-length': template.file_size,
			'content-disposition': contentDisposition(template.original_name),
			'cache-control': 'private, no-store',
			'x-content-type-options': 'nosniff',
		},
	});
};
