import pg from 'pg';
import argon2 from 'argon2';

const { Pool } = pg;
const { DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD } = process.env;

if (!DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (!ADMIN_USERNAME || !/^[a-z0-9._-]{3,100}$/i.test(ADMIN_USERNAME)) {
	throw new Error('Set ADMIN_USERNAME to the administrator login.');
}
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12 || ADMIN_PASSWORD.length > 1024) {
	throw new Error('Set ADMIN_PASSWORD to a password between 12 and 1024 characters.');
}

const pool = new Pool({ connectionString: DATABASE_URL });
try {
	const passwordHash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id });
	const result = await pool.query(
		`UPDATE users
		 SET password_hash = $1, failed_login_count = 0, lockout_until = NULL
		 WHERE username = $2 AND role = 'admin'`,
		[passwordHash, ADMIN_USERNAME.toLowerCase()],
	);
	if (!result.rowCount) throw new Error(`Administrator "${ADMIN_USERNAME.toLowerCase()}" was not found.`);
	console.log(`Password updated for administrator "${ADMIN_USERNAME.toLowerCase()}".`);
} finally {
	await pool.end();
}
