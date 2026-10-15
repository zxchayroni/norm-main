CREATE TABLE department_knowledge_items (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	department_id BIGINT NOT NULL REFERENCES dictionaries(id),
	title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
	created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX department_knowledge_items_department_title_idx
	ON department_knowledge_items (department_id, lower(title));
