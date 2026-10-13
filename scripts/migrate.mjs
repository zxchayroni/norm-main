import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const migrationsDirectory = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
	console.error('DATABASE_URL is required.');
	process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

try {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`);

	const client = await pool.connect();
	try {
		const files = (await readdir(migrationsDirectory))
			.filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
			.sort();

		for (const file of files) {
			const alreadyApplied = await client.query(
				'SELECT 1 FROM schema_migrations WHERE version = $1',
				[file],
			);
			if (alreadyApplied.rowCount) {
				console.log(`Already applied: ${file}`);
				continue;
			}

			const sql = await readFile(path.join(migrationsDirectory, file), 'utf8');
			await client.query('BEGIN');
			try {
				await client.query(sql);
				await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
				await client.query('COMMIT');
				console.log(`Applied: ${file}`);
			} catch (error) {
				await client.query('ROLLBACK');
				throw error;
			}
		}
	} finally {
		client.release();
	}
} catch (error) {
	console.error('Database migration failed:', error);
	process.exitCode = 1;
} finally {
	await pool.end();
}
