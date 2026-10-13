CREATE TABLE file_edit_tokens (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	token_hash BYTEA NOT NULL UNIQUE,
	file_id BIGINT NOT NULL REFERENCES document_files(id) ON DELETE CASCADE,
	user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	expires_at TIMESTAMPTZ NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX file_edit_tokens_expiry_idx ON file_edit_tokens(expires_at);
