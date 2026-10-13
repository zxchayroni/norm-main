import type { APIRoute } from 'astro';
import { getPool } from '../../../lib/server/db';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

export const GET: APIRoute = async ({ url, locals }) => {
	if (locals.user?.role !== 'admin') {
		return new Response(JSON.stringify({ error: 'Недостаточно прав.' }), { status: 403, headers: jsonHeaders });
	}
	const params = url.searchParams;
	const userId = params.get('userId')?.trim() ?? '';
	const action = params.get('action')?.trim().slice(0, 100) ?? '';
	const object = params.get('object')?.trim().slice(0, 100) ?? '';
	const from = params.get('from') ?? '';
	const to = params.get('to') ?? '';
	const limit = Math.min(Math.max(Number.parseInt(params.get('limit') ?? '50', 10) || 50, 1), 200);
	const offset = Math.max(Number.parseInt(params.get('offset') ?? '0', 10) || 0, 0);
	const validDate = (value: string) => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
	if ((userId && !/^[1-9]\d{0,17}$/.test(userId)) || !validDate(from) || !validDate(to)) {
		return new Response(JSON.stringify({ error: 'Некорректные параметры фильтра.' }), { status: 400, headers: jsonHeaders });
	}

	const result = await getPool().query(
		`SELECT a.id, a.user_id AS "userId", u.full_name AS "userName", a.action,
		        a.object_type AS "objectType", a.object_id AS "objectId", a.result,
		        a.ip_address AS "ipAddress", a.details, a.created_at AS "createdAt"
		 FROM audit_log a
		 LEFT JOIN users u ON u.id = a.user_id
		 WHERE ($1 = '' OR a.user_id = NULLIF($1, '')::bigint)
		   AND ($2 = '' OR a.action = $2)
		   AND ($3 = '' OR a.object_type = $3)
		   AND ($4 = '' OR a.created_at >= $4::date)
		   AND ($5 = '' OR a.created_at < $5::date + INTERVAL '1 day')
		 ORDER BY a.created_at DESC, a.id DESC
		 LIMIT $6 OFFSET $7`,
		[userId, action, object, from, to, limit, offset],
	);
	return new Response(JSON.stringify({ entries: result.rows, limit, offset }), { headers: jsonHeaders });
};
