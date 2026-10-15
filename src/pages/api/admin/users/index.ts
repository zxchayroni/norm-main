import type { APIRoute } from 'astro';
import argon2 from 'argon2';
import { assertSameOrigin } from '../../../../lib/server/auth';
import { getPool } from '../../../../lib/server/db';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const roles = new Set(['admin', 'editor', 'reader']);

function fail(error: string, status: number): Response {
	return new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });
}

export const GET: APIRoute = async ({ locals }) => {
	if (locals.user?.role !== 'admin') return fail('Недостаточно прав.', 403);
	const users = await getPool().query(
		`SELECT id, username,
		        concat_ws(' ', NULLIF(btrim(last_name), ''), NULLIF(btrim(first_name), '')) AS "fullName",
		        first_name AS "firstName",
		        last_name AS "lastName", patronymic, email, phone, role,
		        is_active AS "isActive", last_login_at AS "lastLoginAt", created_at AS "createdAt"
		 FROM users ORDER BY full_name, id`,
	);
	return new Response(JSON.stringify({ users: users.rows }), { headers: jsonHeaders });
};

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return fail('Недопустимый источник запроса.', 403);
	if (locals.user?.role !== 'admin') return fail('Недостаточно прав.', 403);
	let input: unknown;
	try { input = await request.json(); } catch { return fail('Некорректный формат запроса.', 400); }
	if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Укажите данные пользователя.', 400);

	const body = input as Record<string, unknown>;
	const username = body.username;
	const password = body.password;
	const legacyNameParts = typeof body.fullName === 'string' ? body.fullName.trim().split(/\s+/) : [];
	const firstName = body.firstName ?? legacyNameParts[0];
	const lastName = body.lastName ?? legacyNameParts[1] ?? '';
	const patronymic = body.patronymic ?? legacyNameParts.slice(2).join(' ');
	const fullName = [lastName, firstName, patronymic].map((part) => typeof part === 'string' ? part.trim() : '').filter(Boolean).join(' ');
	const role = body.role;
	const email = body.email;
	const phone = body.phone;
	if (
		typeof username !== 'string' || !/^[a-z0-9._-]{3,100}$/i.test(username) ||
		typeof password !== 'string' || password.length < 12 || password.length > 1024 ||
		typeof firstName !== 'string' || !firstName.trim() || firstName.trim().length > 100 ||
		typeof lastName !== 'string' || lastName.trim().length > 100 ||
		typeof patronymic !== 'string' || patronymic.trim().length > 100 ||
		fullName.length > 200 ||
		typeof role !== 'string' || !roles.has(role) ||
		(email !== undefined && email !== null && (
			typeof email !== 'string' || email.length > 320 ||
			(email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
		)) ||
		(phone !== undefined && phone !== null && (typeof phone !== 'string' || phone.trim().length > 40))
	) return fail('Проверьте логин, пароль, имя, роль, адрес электронной почты и телефон.', 400);

	const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
	try {
		const result = await getPool().query<{ id: string }>(
			`INSERT INTO users (username, password_hash, full_name, first_name, last_name, patronymic, email, phone, role)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			 RETURNING id`,
			[username.toLowerCase(), passwordHash, fullName, firstName.trim(), lastName.trim(), patronymic.trim(), email?.trim() || null, phone?.trim() || null, role],
		);
		await getPool().query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
			 VALUES ($1, 'user_created', 'user', $2, 'success', $3)`,
			[locals.user.id, result.rows[0].id, clientAddress],
		);
		return new Response(JSON.stringify({ id: result.rows[0].id }), { status: 201, headers: jsonHeaders });
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
			return fail('Пользователь с таким логином уже существует.', 409);
		}
		throw error;
	}
};
