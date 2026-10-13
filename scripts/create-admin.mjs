import pg from 'pg';
import argon2 from 'argon2';

const { Pool } = pg;
const { DATABASE_URL, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD, BOOTSTRAP_ADMIN_NAME } = process.env;

if (!DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (!BOOTSTRAP_ADMIN_USERNAME || !/^[a-z0-9._-]{3,100}$/i.test(BOOTSTRAP_ADMIN_USERNAME)) {
	throw new Error('Set BOOTSTRAP_ADMIN_USERNAME (3–100 letters, digits, dots, underscores, or hyphens).');
}
if (!BOOTSTRAP_ADMIN_PASSWORD || BOOTSTRAP_ADMIN_PASSWORD.length < 12) {
	throw new Error('Set BOOTSTRAP_ADMIN_PASSWORD to a password of at least 12 characters.');
}
if (!BOOTSTRAP_ADMIN_NAME?.trim()) throw new Error('Set BOOTSTRAP_ADMIN_NAME.');

const pool = new Pool({ connectionString: DATABASE_URL });
try {
	const admins = await pool.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1");
	if (admins.rowCount) throw new Error('An administrator already exists; bootstrap is disabled.');

	const passwordHash = await argon2.hash(BOOTSTRAP_ADMIN_PASSWORD, { type: argon2.argon2id });
	await pool.query(
		`INSERT INTO users (username, password_hash, full_name, role)
		 VALUES ($1, $2, $3, 'admin')`,
		[BOOTSTRAP_ADMIN_USERNAME.toLowerCase(), passwordHash, BOOTSTRAP_ADMIN_NAME.trim()],
	);
	console.log(`Administrator "${BOOTSTRAP_ADMIN_USERNAME.toLowerCase()}" created.`);
} finally {
	await pool.end();
}
