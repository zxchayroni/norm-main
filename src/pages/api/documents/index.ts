import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../lib/server/auth';
import { getPool } from '../../../lib/server/db';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const sortColumns: Record<string, string> = {
	updated: 'd.updated_at DESC',
	title: 'd.title ASC',
	date: 'd.doc_date DESC NULLS LAST',
	number: 'd.doc_number ASC',
};

function isValidDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export const GET: APIRoute = async ({ request, locals }) => {
	const params = new URL(request.url).searchParams;
	const query = params.get('q')?.trim().slice(0, 200) ?? '';
	const status = params.get('status')?.trim() ?? '';
	const type = params.get('type')?.trim() ?? '';
	const department = params.get('department')?.trim().slice(0, 200) ?? '';
	const dateFrom = params.get('from')?.trim() ?? '';
	const dateTo = params.get('to')?.trim() ?? '';
	if ((dateFrom && !isValidDate(dateFrom)) || (dateTo && !isValidDate(dateTo))) {
		return new Response(JSON.stringify({ error: 'Некорректный диапазон дат.' }), {
			status: 400,
			headers: { 'content-type': 'application/json; charset=utf-8' },
		});
	}
	const sort = sortColumns[params.get('sort') ?? 'updated'] ?? sortColumns.updated;
	const limit = Math.min(Math.max(Number.parseInt(params.get('limit') ?? '25', 10) || 25, 1), 100);
	const offset = Math.max(Number.parseInt(params.get('offset') ?? '0', 10) || 0, 0);
	const pool = getPool();
	const filters = [
		`d.is_deleted = FALSE`,
		`($1 = '' OR d.title ILIKE '%' || $1 || '%' OR d.doc_number ILIKE '%' || $1 || '%' OR d.description ILIKE '%' || $1 || '%'
		  OR EXISTS (SELECT 1 FROM users qu WHERE qu.id = d.owner_user_id AND qu.full_name ILIKE '%' || $1 || '%')
		  OR EXISTS (SELECT 1 FROM dictionaries qd WHERE qd.id = d.department_id AND qd.name ILIKE '%' || $1 || '%')
		  OR EXISTS (SELECT 1 FROM document_tags qdt JOIN tags qt ON qt.id = qdt.tag_id WHERE qdt.document_id = d.id AND qt.name ILIKE '%' || $1 || '%'))`,
		`($2 = '' OR s.name = $2)`,
		`($3 = '' OR dt.name = $3)`,
		`($4 = '' OR dep.name = $4)`,
		`($5 = 'admin' OR d.access_level = 'organization')`,
		`($6 = FALSE OR d.owner_user_id = $7)`,
		`($8 = FALSE OR d.updated_at >= NOW() - INTERVAL '7 days')`,
		`($9 = '' OR d.doc_date >= $9::date)`,
		`($10 = '' OR d.doc_date <= $10::date)`,
	].join(' AND ');
	const values = [
		query, status, type, department, locals.user?.role ?? 'reader',
		params.get('mine') === '1', locals.user?.id ?? null,
		params.get('recent') === '1',
		dateFrom, dateTo,
	];

	const [countResult, archiveCount, documents, statusSummary, createdThisMonth] = await Promise.all([
		pool.query<{ total: string }>(
			`SELECT COUNT(*)::text AS total
			 FROM documents d
			 LEFT JOIN dictionaries s ON s.id = d.status_id
			 LEFT JOIN dictionaries dt ON dt.id = d.doc_type_id
			 LEFT JOIN dictionaries dep ON dep.id = d.department_id
			 WHERE ${filters}`,
			values,
		),
		pool.query<{ total: string }>(
			`SELECT COUNT(*)::text AS total
			 FROM documents d
			 WHERE NOT d.is_deleted
			   AND ($1 = 'admin' OR d.access_level = 'organization')`,
			[locals.user?.role ?? 'reader'],
		),
		pool.query(
			`SELECT d.id, d.title, d.doc_number AS number,
			        to_char(d.doc_date, 'DD.MM.YYYY') AS date,
			        to_char(d.doc_date, 'YYYY-MM-DD') AS "dateIso",
			        dt.name AS type, s.name AS status, dep.name AS department,
			        d.updated_at AS updated,
			        COALESCE(files.file_count, 0)::integer AS files,
			        owner.full_name AS owner, d.description
			 FROM documents d
			 LEFT JOIN dictionaries s ON s.id = d.status_id
			 LEFT JOIN dictionaries dt ON dt.id = d.doc_type_id
			 LEFT JOIN dictionaries dep ON dep.id = d.department_id
			 LEFT JOIN users owner ON owner.id = d.owner_user_id
			 LEFT JOIN LATERAL (
			   SELECT COUNT(*) AS file_count
			   FROM document_files f
			   WHERE f.document_id = d.id AND f.is_current AND NOT f.is_deleted
			 ) files ON TRUE
			 WHERE ${filters}
			 ORDER BY ${sort}, d.id DESC
			 LIMIT $11 OFFSET $12`,
			[...values, limit, offset],
		),
		pool.query<{ status: string; total: number }>(
			`SELECT COALESCE(s.name, 'Без статуса') AS status, COUNT(*)::integer AS total
			 FROM documents d
			 LEFT JOIN dictionaries s ON s.id = d.status_id
			 WHERE NOT d.is_deleted AND ($1 = 'admin' OR d.access_level = 'organization')
			 GROUP BY s.name`,
			[locals.user?.role ?? 'reader'],
		),
		pool.query<{ total: number }>(
			`SELECT COUNT(*)::integer AS total
			 FROM documents
			 WHERE NOT is_deleted
			   AND ($1 = 'admin' OR access_level = 'organization')
			   AND created_at >= date_trunc('month', NOW())`,
			[locals.user?.role ?? 'reader'],
		),
	]);

	return new Response(JSON.stringify({
		documents: documents.rows,
		total: Number(countResult.rows[0].total),
		archiveTotal: Number(archiveCount.rows[0].total),
		statusSummary: Object.fromEntries(statusSummary.rows.map((item) => [item.status, item.total])),
		createdThisMonth: createdThisMonth.rows[0].total,
		limit,
		offset,
	}), { headers: jsonHeaders });
};

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) {
		return new Response(JSON.stringify({ error: 'Недопустимый источник запроса.' }), {
			status: 403,
			headers: jsonHeaders,
		});
	}

	if (locals.user?.role === 'reader') {
		return new Response(JSON.stringify({ error: 'Недостаточно прав для создания документа.' }), {
			status: 403,
			headers: jsonHeaders,
		});
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: 'Некорректный формат запроса.' }), {
			status: 400,
			headers: jsonHeaders,
		});
	}

	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return new Response(JSON.stringify({ error: 'Укажите данные документа.' }), { status: 400, headers: jsonHeaders });
	}

	const input = body as Record<string, unknown>;
	const { title, number, date, type, status, description, department } = input;
	const tags = input.tags ?? [];
	const effectiveDate = input.effectiveDate ?? null;
	const expiryDate = input.expiryDate ?? null;
	const legalBasis = input.legalBasis ?? '';
	const paperLocation = input.paperLocation ?? '';
	const notes = input.notes ?? '';
	const accessLevel = input.accessLevel ?? 'organization';
	if (
		Object.keys(input).some((key) => ![
			'title', 'number', 'date', 'type', 'status', 'description', 'department',
			'tags', 'effectiveDate', 'expiryDate', 'legalBasis', 'paperLocation', 'notes',
			'accessLevel', 'allowDuplicate',
		].includes(key)) ||
		typeof title !== 'string' || !title.trim() || title.trim().length > 300 ||
		typeof type !== 'string' || !type.trim() || type.length > 100 ||
		(number !== undefined && (typeof number !== 'string' || number.length > 100)) ||
		(date !== undefined && date !== null && date !== '' && (typeof date !== 'string' || !isValidDate(date))) ||
		(effectiveDate !== null && effectiveDate !== '' && (typeof effectiveDate !== 'string' || !isValidDate(effectiveDate))) ||
		(expiryDate !== null && expiryDate !== '' && (typeof expiryDate !== 'string' || !isValidDate(expiryDate))) ||
		(status !== undefined && (typeof status !== 'string' || status.length > 100)) ||
		(description !== undefined && (typeof description !== 'string' || description.length > 5000)) ||
		(department !== undefined && (typeof department !== 'string' || department.length > 200)) ||
		(typeof legalBasis !== 'string' || legalBasis.length > 1000) ||
		(typeof paperLocation !== 'string' || paperLocation.length > 500) ||
		(typeof notes !== 'string' || notes.length > 5000) ||
		(accessLevel !== 'organization' && accessLevel !== 'restricted') ||
		(accessLevel === 'restricted' && locals.user?.role !== 'admin') ||
		!Array.isArray(tags) || tags.length > 30 ||
		tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.trim().length > 50) ||
		(input.allowDuplicate !== undefined && typeof input.allowDuplicate !== 'boolean')
	) {
		return new Response(JSON.stringify({ error: 'Проверьте обязательные поля и их формат.' }), { status: 400, headers: jsonHeaders });
	}

	const pool = getPool();
	const client = await pool.connect();
	let transactionStarted = false;
	try {
		const typeResult = await client.query(
			"SELECT id FROM dictionaries WHERE type = 'doc_type' AND name = $1 AND is_active",
			[type.trim()],
		);
		const statusName = typeof status === 'string' && status.trim() ? status.trim() : 'Проект';
		const statusResult = await client.query(
			"SELECT id FROM dictionaries WHERE type = 'status' AND name = $1 AND is_active",
			[statusName],
		);
		const departmentName = typeof department === 'string' ? department.trim() : '';
		const departmentResult = departmentName
			? await client.query(
				"SELECT id FROM dictionaries WHERE type = 'department' AND name = $1 AND is_active",
				[departmentName],
			)
			: { rows: [], rowCount: 0 };

		if (!typeResult.rowCount || !statusResult.rowCount || (departmentName && !departmentResult.rowCount)) {
			return new Response(JSON.stringify({ error: 'Выберите действующие значения из справочников.' }), {
				status: 400,
				headers: jsonHeaders,
			});
		}

		await client.query('BEGIN');
		transactionStarted = true;
		const duplicateMatches = await client.query<{ id: string; title: string; number: string }>(
			`SELECT id, title, doc_number AS number
			 FROM documents
			 WHERE NOT is_deleted
			   AND (
			     ($1 <> '' AND lower(doc_number) = lower($1))
			     OR ($2::date IS NOT NULL AND doc_date = $2::date AND lower(title) = lower($3))
			   )
			 ORDER BY updated_at DESC
			 LIMIT 5`,
			[typeof number === 'string' ? number.trim() : '', typeof date === 'string' && date ? date : null, title.trim()],
		);
		if (duplicateMatches.rowCount && input.allowDuplicate !== true) {
			await client.query('ROLLBACK');
			transactionStarted = false;
			return new Response(JSON.stringify({
				error: 'Найдены документы с совпадающими реквизитами.',
				duplicates: duplicateMatches.rows,
			}), { status: 409, headers: jsonHeaders });
		}
		const inserted = await client.query<{ id: string }>(
			`INSERT INTO documents
			   (title, doc_type_id, doc_number, doc_date, effective_date, expiry_date, status_id, description,
			    department_id, owner_user_id, created_by, updated_by, legal_basis, paper_location, notes, access_level)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10, $11, $12, $13, $14)
			 RETURNING id`,
			[
				title.trim(),
				typeResult.rows[0].id,
				typeof number === 'string' ? number.trim() : '',
				typeof date === 'string' && date ? date : null,
				typeof effectiveDate === 'string' && effectiveDate ? effectiveDate : null,
				typeof expiryDate === 'string' && expiryDate ? expiryDate : null,
				statusResult.rows[0].id,
				typeof description === 'string' ? description.trim() : '',
				departmentResult.rows[0]?.id ?? null,
				locals.user?.id,
				legalBasis.trim(),
				paperLocation.trim(),
				notes.trim(),
				accessLevel,
			],
		);
		const documentId = inserted.rows[0].id;
		for (const tag of tags as string[]) {
			const insertedTag = await client.query<{ id: string }>(
				'INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
				[tag.trim()],
			);
			await client.query('INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2)', [documentId, insertedTag.rows[0].id]);
		}
		await client.query(
			'INSERT INTO document_history (document_id, user_id, action) VALUES ($1, $2, $3)',
			[documentId, locals.user?.id, 'created'],
		);
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
			 VALUES ($1, 'document_created', 'document', $2, 'success', $3)`,
			[locals.user?.id, documentId, clientAddress],
		);
		await client.query('COMMIT');
		transactionStarted = false;

		return new Response(JSON.stringify({ id: documentId }), { status: 201, headers: jsonHeaders });
	} catch (error) {
		if (transactionStarted) await client.query('ROLLBACK').catch((rollbackError: unknown) => {
			console.error('Failed to rollback document creation:', rollbackError);
		});
		throw error;
	} finally {
		client.release();
	}
};
