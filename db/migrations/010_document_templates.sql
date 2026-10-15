CREATE TABLE document_templates (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	original_name TEXT NOT NULL,
	stored_path TEXT NOT NULL UNIQUE,
	extension TEXT NOT NULL,
	mime_type TEXT NOT NULL,
	file_size BIGINT NOT NULL CHECK (file_size >= 0 AND file_size <= 104857600),
	sha256 CHAR(64) NOT NULL,
	uploaded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
	uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX document_templates_uploaded_at_idx
	ON document_templates(uploaded_at DESC)
	WHERE NOT is_deleted;
