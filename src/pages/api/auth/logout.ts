import type { APIRoute } from 'astro';
import { assertSameOrigin, revokeSession } from '../../../lib/server/auth';
import { audit } from '../../../lib/server/db';

export const POST: APIRoute = async ({ request, cookies, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) {
		return new Response(JSON.stringify({ error: 'Недопустимый источник запроса.' }), {
			status: 403,
			headers: { 'content-type': 'application/json; charset=utf-8' },
		});
	}

	await revokeSession(cookies);
	if (locals.user) await audit(locals.user.id, 'logout', 'user', locals.user.id, 'success', {}, clientAddress);
	return new Response(null, { status: 204 });
};
