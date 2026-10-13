import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { APIRoute } from 'astro';
import { Readable } from 'node:stream';
import { getPool } from '../../../../lib/server/db';
import { resolveStoredPath } from '../../../../lib/server/storage';

export const GET: APIRoute = async ({ params }) => {
	const token = params.token ?? '';
	const filename = params.filename ?? '';
	if (!/^[a-f0-9]{64}$/i.test(token) || !/^document\.(docx|xlsx)$/i.test(filename)) {
		return new Response('Not found', { status: 404 });
	}

	const tokenHash = createHash('sha256').update(token).digest();
	const result = await getPool().query<{
		id: string; original_name: string; stored_path: string; extension: string; mime_type: string; file_size: string;
	}>(
		`SELECT f.id, f.original_name, f.stored_path, f.extension, f.mime_type, f.file_size
		 FROM file_edit_tokens t
		 JOIN document_files f ON f.id = t.file_id
		 JOIN documents d ON d.id = f.document_id
		 JOIN users u ON u.id = t.user_id
		 WHERE t.token_hash = $1 AND t.expires_at > NOW()
		   AND u.is_active AND f.is_current AND NOT f.is_deleted AND NOT d.is_deleted`,
		[tokenHash],
	);
	const file = result.rows[0];
	if (!file || filename.toLowerCase() !== `document.${file.extension}`) {
		return new Response('Not found', { status: 404 });
	}

	const safeFilename = file.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	const encodedFilename = encodeURIComponent(file.original_name);
	const stream = createReadStream(resolveStoredPath(file.stored_path));
	stream.on('error', (error) => console.error(`Unable to stream Office file ${file.id}:`, error));
	return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
		headers: {
			'content-type': file.mime_type,
			'content-length': file.file_size,
			'content-disposition': `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`,
			'cache-control': 'private, no-store',
			'x-content-type-options': 'nosniff',
		},
	});
};
