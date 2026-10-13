CREATE TABLE users (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	username TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	full_name TEXT NOT NULL,
	email TEXT,
	role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'reader')),
	is_active BOOLEAN NOT NULL DEFAULT TRUE,
	failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
	lockout_until TIMESTAMPTZ,
	last_login_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sessions (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	token_hash BYTEA NOT NULL UNIQUE,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	expires_at TIMESTAMPTZ NOT NULL,
	ip_address INET,
	user_agent TEXT
);

CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);

CREATE TABLE dictionaries (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	type TEXT NOT NULL CHECK (type IN ('doc_type', 'status', 'department', 'file_kind')),
	name TEXT NOT NULL,
	is_active BOOLEAN NOT NULL DEFAULT TRUE,
	sort_order INTEGER NOT NULL DEFAULT 0,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	UNIQUE (type, name)
);

CREATE TABLE documents (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	title TEXT NOT NULL,
	doc_type_id BIGINT REFERENCES dictionaries(id),
	doc_number TEXT NOT NULL DEFAULT '',
	doc_date DATE,
	effective_date DATE,
	expiry_date DATE,
	status_id BIGINT REFERENCES dictionaries(id),
	description TEXT NOT NULL DEFAULT '',
	department_id BIGINT REFERENCES dictionaries(id),
	owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
	access_level TEXT NOT NULL DEFAULT 'organization' CHECK (access_level IN ('organization', 'restricted')),
	paper_location TEXT,
	legal_basis TEXT,
	notes TEXT,
	created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
	updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX documents_title_idx ON documents USING GIN (to_tsvector('simple', title));
CREATE INDEX documents_number_idx ON documents (doc_number);
CREATE INDEX documents_date_idx ON documents (doc_date DESC);
CREATE INDEX documents_status_idx ON documents (status_id);
CREATE INDEX documents_type_idx ON documents (doc_type_id);
CREATE INDEX documents_department_idx ON documents (department_id);
CREATE INDEX documents_updated_idx ON documents (updated_at DESC);

CREATE TABLE tags (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	name TEXT NOT NULL UNIQUE
);

CREATE TABLE document_tags (
	document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
	PRIMARY KEY (document_id, tag_id)
);

CREATE TABLE document_relations (
	document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	related_document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	PRIMARY KEY (document_id, related_document_id),
	CHECK (document_id <> related_document_id)
);

CREATE TABLE document_files (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	attachment_id UUID NOT NULL,
	original_name TEXT NOT NULL,
	stored_path TEXT NOT NULL UNIQUE,
	extension TEXT NOT NULL,
	mime_type TEXT NOT NULL,
	file_size BIGINT NOT NULL CHECK (file_size >= 0 AND file_size <= 104857600),
	sha256 CHAR(64) NOT NULL,
	file_kind_id BIGINT REFERENCES dictionaries(id),
	version INTEGER NOT NULL CHECK (version > 0),
	is_current BOOLEAN NOT NULL DEFAULT TRUE,
	comment TEXT,
	uploaded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
	uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
	UNIQUE (attachment_id, version)
);

CREATE UNIQUE INDEX document_files_one_current_version
	ON document_files(attachment_id)
	WHERE is_current AND NOT is_deleted;
CREATE INDEX document_files_document_id_idx ON document_files(document_id);
CREATE INDEX document_files_sha256_idx ON document_files(sha256);

CREATE TABLE document_history (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
	action TEXT NOT NULL,
	field_name TEXT,
	old_value TEXT,
	new_value TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX document_history_document_idx ON document_history(document_id, created_at DESC);

CREATE TABLE audit_log (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
	action TEXT NOT NULL,
	object_type TEXT NOT NULL,
	object_id TEXT,
	ip_address INET,
	result TEXT NOT NULL CHECK (result IN ('success', 'failure')),
	details JSONB NOT NULL DEFAULT '{}'::JSONB,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_log_created_idx ON audit_log(created_at DESC);
CREATE INDEX audit_log_user_idx ON audit_log(user_id, created_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log(action, created_at DESC);

INSERT INTO dictionaries (type, name, sort_order) VALUES
	('doc_type', 'Приказ', 1),
	('doc_type', 'Распоряжение', 2),
	('doc_type', 'Положение', 3),
	('doc_type', 'Инструкция', 4),
	('doc_type', 'Регламент', 5),
	('doc_type', 'Методические рекомендации', 6),
	('doc_type', 'Письмо', 7),
	('doc_type', 'Договор', 8),
	('doc_type', 'Иной документ', 9),
	('status', 'Проект', 1),
	('status', 'На согласовании', 2),
	('status', 'Действует', 3),
	('status', 'Утратил силу', 4),
	('status', 'Архив', 5),
	('file_kind', 'Исходный документ', 1),
	('file_kind', 'Подписанный скан', 2),
	('file_kind', 'Приложение', 3),
	('file_kind', 'Дополнительный материал', 4),
	('file_kind', 'Иной файл', 5);
