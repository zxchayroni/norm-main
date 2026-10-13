import { Pool } from 'pg';

let pool: Pool | undefined;

export function getPool(): Pool {
	if (!process.env.DATABASE_URL) {
		throw new Error('DATABASE_URL is required to connect to PostgreSQL.');
	}

	if (!pool) {
		pool = new Pool({
			connectionString: process.env.DATABASE_URL,
			max: Number(process.env.DB_POOL_SIZE ?? 20),
			idleTimeoutMillis: 30_000,
			connectionTimeoutMillis: 5_000,
		});

		pool.on('error', (error) => {
			console.error('Unexpected idle PostgreSQL client error:', error);
		});
	}

	return pool;
}

export function audit(
	userId: string | null,
	action: string,
	objectType: string,
	objectId: string | null,
	result: 'success' | 'failure',
	details: Record<string, unknown> = {},
	ipAddress: string | null = null,
): Promise<unknown> {
	return getPool().query(
		`INSERT INTO audit_log (user_id, action, object_type, object_id, result, details, ip_address)
		 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
		[userId, action, objectType, objectId, result, JSON.stringify(details), ipAddress],
	);
}
