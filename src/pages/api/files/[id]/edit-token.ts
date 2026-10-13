import { createHash, randomBytes } from 'node:crypto';
import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../../lib/server/auth';
import { getPool } from '../../../../lib/server/db';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

export const POST: APIRoute = async ({ params, request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) {
		return new Response(JSON.stringify({ error: 'Недопустимый источник запроса.' }), { status: 403, headers: jsonHeaders });
	}
	if (locals.user?.role === 'reader') {
		return new Response(JSON.stringify({ error: 'Недостаточно прав для редактирования файла.' }), { status: 403, headers: jsonHeaders });
	}
	const fileId = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(fileId)) {
		return new Response(JSON.stringify({ error: 'Некорректный идентификатор файла.' }), { status: 400, headers: jsonHeaders });
	}

	const file = await getPool().query<{ id: string; extension: string }>(
		`SELECT f.id, f.extension
		 FROM document_files f
		 JOIN documents d ON d.id = f.document_id
		 WHERE f.id = $1 AND f.is_current AND NOT f.is_deleted AND NOT d.is_deleted
		   AND f.extension IN ('docx', 'xlsx')
		   AND ($2 = 'admin' OR d.access_level = 'organization')`,
		[fileId, locals.user.role],
	);
	if (!file.rowCount) {
		return new Response(JSON.stringify({ error: 'Актуальный DOCX/XLSX файл не найден.' }), { status: 404, headers: jsonHeaders });
	}

	const baseUrl = process.env.PUBLIC_BASE_URL;
	if (!baseUrl) throw new Error('PUBLIC_BASE_URL must be configured to create Office edit links.');
	const publicOrigin = new URL(process.env.NODE_ENV === 'production' ? baseUrl : request.url);
	if (publicOrigin.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
		throw new Error('PUBLIC_BASE_URL must use HTTPS in production.');
	}
	if (publicOrigin.username || publicOrigin.password) throw new Error('PUBLIC_BASE_URL must not contain credentials.');

	const token = randomBytes(32).toString('hex');
	const tokenHash = createHash('sha256').update(token).digest();
	const extension = file.rows[0].extension;
	const url = new URL(`/api/edit/${token}/document.${extension}`, publicOrigin);
	await getPool().query(
		`INSERT INTO file_edit_tokens (token_hash, file_id, user_id, expires_at)
		 VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
		[tokenHash, fileId, locals.user.id],
	);
	await getPool().query(
		`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
		 VALUES ($1, 'file_edit_link_created', 'file', $2, 'success', $3)`,
		[locals.user.id, fileId, clientAddress],
	);

	const scheme = file.rows[0].extension === 'docx' ? 'ms-word' : 'ms-excel';
	return new Response(JSON.stringify({
		url: `${scheme}:${url.toString()}`,
		expiresInSeconds: 600,
	}), { headers: jsonHeaders });
};
