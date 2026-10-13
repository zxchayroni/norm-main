import type { APIRoute } from 'astro';
import { assertSameOrigin } from '../../../lib/server/auth';
import { getPool } from '../../../lib/server/db';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const textFields = {
	title: { column: 'title', limit: 300, required: true },
	number: { column: 'doc_number', limit: 100, required: false },
	description: { column: 'description', limit: 5000, required: false },
	legalBasis: { column: 'legal_basis', limit: 1000, required: false },
	paperLocation: { column: 'paper_location', limit: 500, required: false },
	notes: { column: 'notes', limit: 5000, required: false },
} as const;
const dictionaryFields = {
	type: { column: 'doc_type_id', type: 'doc_type' },
	status: { column: 'status_id', type: 'status' },
	department: { column: 'department_id', type: 'department' },
} as const;

function validDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function badRequest(message: string, status = 400): Response {
	return new Response(JSON.stringify({ error: message }), { status, headers: jsonHeaders });
}

export const GET: APIRoute = async ({ params, locals }) => {
	const id = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(id)) return badRequest('Некорректный идентификатор документа.');

	const result = await getPool().query(
		`SELECT d.id, d.title, d.doc_number AS number,
		        to_char(d.doc_date, 'YYYY-MM-DD') AS date,
		        to_char(d.effective_date, 'YYYY-MM-DD') AS "effectiveDate",
		        to_char(d.expiry_date, 'YYYY-MM-DD') AS "expiryDate",
		        dt.name AS type, s.name AS status, dep.name AS department,
		        d.description, d.legal_basis AS "legalBasis", d.paper_location AS "paperLocation",
		        d.notes, d.access_level AS "accessLevel", owner.full_name AS owner,
		        d.created_at AS "createdAt", d.updated_at AS "updatedAt",
		        COALESCE((
		          SELECT jsonb_agg(jsonb_build_object(
		            'id', f.id, 'name', f.original_name, 'version', f.version, 'size', f.file_size,
		            'kind', fk.name, 'comment', f.comment, 'uploadedAt', f.uploaded_at,
		            'uploadedBy', uploader.full_name, 'isCurrent', f.is_current
		          ) ORDER BY f.uploaded_at DESC)
		          FROM document_files f
		          LEFT JOIN dictionaries fk ON fk.id = f.file_kind_id
		          LEFT JOIN users uploader ON uploader.id = f.uploaded_by
		          WHERE f.document_id = d.id AND f.is_current AND NOT f.is_deleted
		        ), '[]'::jsonb) AS files,
		        COALESCE((
		          SELECT jsonb_agg(t.name ORDER BY t.name)
		          FROM document_tags dtags
		          JOIN tags t ON t.id = dtags.tag_id
		          WHERE dtags.document_id = d.id
		        ), '[]'::jsonb) AS tags,
		        COALESCE((
		          SELECT jsonb_agg(jsonb_build_object(
		            'action', h.action, 'field', h.field_name, 'oldValue', h.old_value,
		            'newValue', h.new_value, 'createdAt', h.created_at, 'user', editor.full_name
		          ) ORDER BY h.created_at DESC)
		          FROM document_history h
		          LEFT JOIN users editor ON editor.id = h.user_id
		          WHERE h.document_id = d.id
		        ), '[]'::jsonb) AS history
		 FROM documents d
		 LEFT JOIN dictionaries dt ON dt.id = d.doc_type_id
		 LEFT JOIN dictionaries s ON s.id = d.status_id
		 LEFT JOIN dictionaries dep ON dep.id = d.department_id
		 LEFT JOIN users owner ON owner.id = d.owner_user_id
		 WHERE d.id = $1 AND NOT d.is_deleted
		   AND ($2 = 'admin' OR d.access_level = 'organization')`,
		[id, locals.user?.role ?? 'reader'],
	);
	if (!result.rowCount) return badRequest('Документ не найден.', 404);
	return new Response(JSON.stringify({ document: result.rows[0] }), { headers: jsonHeaders });
};

export const PATCH: APIRoute = async ({ params, request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return badRequest('Недопустимый источник запроса.', 403);
	if (locals.user?.role === 'reader') return badRequest('Недостаточно прав для изменения документа.', 403);

	const id = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(id)) return badRequest('Некорректный идентификатор документа.');

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return badRequest('Некорректный формат запроса.');
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest('Укажите поля для изменения.');

	const input = body as Record<string, unknown>;
	const allowedFields = new Set([
		'title', 'number', 'description', 'legalBasis', 'paperLocation', 'notes',
		'type', 'status', 'department', 'date', 'effectiveDate', 'expiryDate',
		'accessLevel', 'tags',
	]);
	if (Object.keys(input).some((field) => !allowedFields.has(field))) return badRequest('Запрос содержит неизвестные поля.');
	if (
		input.tags !== undefined &&
		(!Array.isArray(input.tags) || input.tags.length > 30 ||
			input.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.trim().length > 50))
	) return badRequest('Укажите не более 30 корректных тегов.');
	const pool = getPool();
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const existing = await client.query(
			'SELECT * FROM documents WHERE id = $1 AND NOT is_deleted FOR UPDATE',
			[id],
		);
		if (!existing.rowCount) {
			await client.query('ROLLBACK');
			return badRequest('Документ не найден.', 404);
		}
		if (existing.rows[0].access_level === 'restricted' && locals.user?.role !== 'admin') {
			await client.query('ROLLBACK');
			return badRequest('Документ доступен только администратору.', 403);
		}

		const assignments: string[] = [];
		const values: unknown[] = [];
		const changes: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
		const append = (column: string, value: unknown, historyField: string, oldValue: unknown) => {
			values.push(value);
			assignments.push(`${column} = $${values.length}`);
			changes.push({
				field: historyField,
				oldValue: oldValue === null || oldValue === undefined ? null : String(oldValue),
				newValue: value === null || value === undefined ? null : String(value),
			});
		};

		for (const [field, definition] of Object.entries(textFields)) {
			if (!(field in input)) continue;
			const value = input[field];
			if (typeof value !== 'string' || value.trim().length > definition.limit || (definition.required && !value.trim())) {
				await client.query('ROLLBACK');
				return badRequest(`Некорректное значение поля "${field}".`);
			}
			const previousValue = existing.rows[0][definition.column];
			const normalized = value.trim();
			if (previousValue !== normalized) append(definition.column, normalized, field, previousValue);
		}

		for (const [field, definition] of Object.entries(dictionaryFields)) {
			if (!(field in input)) continue;
			const name = input[field];
			if (typeof name !== 'string' || !name.trim() || name.length > 200) {
				await client.query('ROLLBACK');
				return badRequest(`Некорректное значение поля "${field}".`);
			}
			const dictionary = await client.query(
				'SELECT id FROM dictionaries WHERE type = $1 AND name = $2 AND is_active',
				[definition.type, name.trim()],
			);
			if (!dictionary.rowCount) {
				await client.query('ROLLBACK');
				return badRequest(`Значение "${name}" отсутствует в справочнике.`);
			}
			const previousValue = existing.rows[0][definition.column];
			if (previousValue !== dictionary.rows[0].id) append(definition.column, dictionary.rows[0].id, field, previousValue);
		}

		for (const field of ['date', 'effectiveDate', 'expiryDate'] as const) {
			if (!(field in input)) continue;
			const value = input[field];
			if (value !== null && value !== '' && (typeof value !== 'string' || !validDate(value))) {
				await client.query('ROLLBACK');
				return badRequest(`Некорректная дата в поле "${field}".`);
			}
			const column = { date: 'doc_date', effectiveDate: 'effective_date', expiryDate: 'expiry_date' }[field];
			const normalized = typeof value === 'string' && value ? value : null;
			const previousValue = existing.rows[0][column];
			const previousDate = previousValue instanceof Date ? previousValue.toISOString().slice(0, 10) : previousValue;
			if (previousDate !== normalized) append(column, normalized, field, previousDate);
		}

		if (input.accessLevel !== undefined) {
			if (locals.user?.role !== 'admin') {
				await client.query('ROLLBACK');
				return badRequest('Изменять гриф доступа может только администратор.', 403);
			}
			if (input.accessLevel !== 'organization' && input.accessLevel !== 'restricted') {
				await client.query('ROLLBACK');
				return badRequest('Некорректный гриф доступа.');
			}
			if (existing.rows[0].access_level !== input.accessLevel) {
				append('access_level', input.accessLevel, 'accessLevel', existing.rows[0].access_level);
			}
		}

		if (Array.isArray(input.tags)) {
			const newTags = [...new Set(input.tags.map((tag) => (tag as string).trim()))];
			const oldTagsResult = await client.query<{ name: string }>(
				`SELECT t.name FROM document_tags dt
				 JOIN tags t ON t.id = dt.tag_id
				 WHERE dt.document_id = $1 ORDER BY t.name`,
				[id],
			);
			const oldTags = oldTagsResult.rows.map((tag) => tag.name);
			if (JSON.stringify(oldTags) !== JSON.stringify(newTags.sort((a, b) => a.localeCompare(b, 'ru')))) {
				const newTagIds: string[] = [];
				for (const tag of newTags) {
					const savedTag = await client.query<{ id: string }>(
						'INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
						[tag],
					);
					newTagIds.push(savedTag.rows[0].id);
				}
				await client.query(
					'DELETE FROM document_tags WHERE document_id = $1 AND NOT (tag_id = ANY($2::bigint[]))',
					[id, newTagIds],
				);
				for (const tagId of newTagIds) {
					await client.query(
						'INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
						[id, tagId],
					);
				}
				changes.push({ field: 'tags', oldValue: JSON.stringify(oldTags), newValue: JSON.stringify(newTags) });
			}
		}

		if (!changes.length) {
			await client.query('ROLLBACK');
			return new Response(JSON.stringify({ id, changed: false }), { headers: jsonHeaders });
		}

		values.push(id, locals.user?.id);
		await client.query(
			`UPDATE documents SET ${assignments.join(', ')}, updated_by = $${values.length}, updated_at = NOW() WHERE id = $${values.length - 1}`,
			values,
		);
		for (const change of changes) {
			await client.query(
				`INSERT INTO document_history (document_id, user_id, action, field_name, old_value, new_value)
				 VALUES ($1, $2, 'updated', $3, $4, $5)`,
				[id, locals.user?.id, change.field, change.oldValue, change.newValue],
			);
		}
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address, details)
			 VALUES ($1, 'document_updated', 'document', $2, 'success', $3, $4::jsonb)`,
			[locals.user?.id, id, clientAddress, JSON.stringify({ fields: changes.map(({ field }) => field) })],
		);
		await client.query('COMMIT');
		return new Response(JSON.stringify({ id, changed: true }), { headers: jsonHeaders });
	} catch (error) {
		await client.query('ROLLBACK').catch((rollbackError: unknown) => {
			console.error('Failed to rollback document update:', rollbackError);
		});
		throw error;
	} finally {
		client.release();
	}
};

export const DELETE: APIRoute = async ({ params, request, locals, clientAddress }) => {
	if (!assertSameOrigin(request)) return badRequest('Недопустимый источник запроса.', 403);
	if (locals.user?.role !== 'admin') return badRequest('Удалять документы может только администратор.', 403);
	const id = params.id ?? '';
	if (!/^[1-9]\d{0,17}$/.test(id)) return badRequest('Некорректный идентификатор документа.');

	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		const document = await client.query('UPDATE documents SET is_deleted = TRUE, updated_by = $2, updated_at = NOW() WHERE id = $1 AND NOT is_deleted RETURNING id', [id, locals.user.id]);
		if (!document.rowCount) {
			await client.query('ROLLBACK');
			return badRequest('Документ не найден.', 404);
		}
		await client.query('UPDATE document_files SET is_deleted = TRUE, is_current = FALSE WHERE document_id = $1', [id]);
		await client.query(
			'INSERT INTO document_history (document_id, user_id, action) VALUES ($1, $2, $3)',
			[id, locals.user.id, 'deleted'],
		);
		await client.query(
			`INSERT INTO audit_log (user_id, action, object_type, object_id, result, ip_address)
			 VALUES ($1, 'document_deleted', 'document', $2, 'success', $3)`,
			[locals.user.id, id, clientAddress],
		);
		await client.query('COMMIT');
		return new Response(null, { status: 204 });
	} catch (error) {
		await client.query('ROLLBACK').catch((rollbackError: unknown) => {
			console.error('Failed to rollback document deletion:', rollbackError);
		});
		throw error;
	} finally {
		client.release();
	}
};
