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

	try {
		await revokeSession(cookies);
	} catch (error) {
		console.error('Failed to revoke the server-side session during logout:', error);
		return new Response(JSON.stringify({
			error: 'Сессия удалена из этого браузера, но сервер не подтвердил её отзыв.',
		}), {
			status: 503,
			headers: { 'content-type': 'application/json; charset=utf-8' },
		});
	}

	if (locals.user) {
		try {
			await audit(locals.user.id, 'logout', 'user', locals.user.id, 'success', {}, clientAddress);
		} catch (error) {
			console.error('The session was revoked, but the logout audit event could not be recorded:', error);
		}
	}
	return new Response(null, { status: 204 });
};
