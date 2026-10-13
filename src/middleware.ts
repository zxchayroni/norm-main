import { defineMiddleware } from 'astro:middleware';
import { getSessionUser } from './lib/server/auth';

const publicPaths = new Set(['/api/auth/login', '/api/auth/me', '/favicon.svg', '/favicon.ico']);

export const onRequest = defineMiddleware(async (context, next) => {
	if (
		publicPaths.has(context.url.pathname) ||
		context.url.pathname.startsWith('/_astro/') ||
		context.url.pathname.startsWith('/assets/') ||
		context.url.pathname.startsWith('/api/edit/')
	) {
		context.locals.user = null;
		return next();
	}

	if (context.url.pathname === '/api/auth/logout' && !context.cookies.has('doc_archive_session')) {
		context.locals.user = null;
		return next();
	}

	if (!context.cookies.has('doc_archive_session')) {
		context.locals.user = null;
		if (context.url.pathname === '/login') return next();
		if (context.url.pathname.startsWith('/api/')) {
			return new Response(JSON.stringify({ error: 'Требуется авторизация.' }), {
				status: 401,
				headers: { 'content-type': 'application/json; charset=utf-8' },
			});
		}
		return context.redirect('/login');
	}

	const user = await getSessionUser(context.request, context.cookies);
	if (context.url.pathname === '/login') {
		context.locals.user = null;
		return user ? context.redirect('/') : next();
	}

	if (!user) {
		if (context.url.pathname.startsWith('/api/')) {
			return new Response(JSON.stringify({ error: 'Требуется авторизация.' }), {
				status: 401,
				headers: { 'content-type': 'application/json; charset=utf-8' },
			});
		}
		return context.redirect('/login');
	}

	context.locals.user = user;
	return next();
});
