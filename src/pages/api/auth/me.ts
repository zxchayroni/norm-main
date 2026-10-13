import type { APIRoute } from 'astro';
import { getSessionUser, SESSION_COOKIE } from '../../../lib/server/auth';

export const GET: APIRoute = async ({ request, cookies }) => {
	if (!cookies.has(SESSION_COOKIE)) {
		return new Response(JSON.stringify({ error: 'Требуется авторизация.' }), {
			status: 401,
			headers: { 'content-type': 'application/json; charset=utf-8' },
		});
	}

	const user = await getSessionUser(request, cookies);
	if (!user) {
		return new Response(JSON.stringify({ error: 'Требуется авторизация.' }), {
			status: 401,
			headers: { 'content-type': 'application/json; charset=utf-8' },
		});
	}

	return new Response(JSON.stringify({ user }), {
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
};
