CREATE TABLE import_batches (
	id UUID PRIMARY KEY,
	user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	source_name TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed', 'cancelled')),
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
	committed_at TIMESTAMPTZ
);

CREATE INDEX import_batches_user_idx ON import_batches(user_id, created_at DESC);
CREATE INDEX import_batches_expiry_idx ON import_batches(expires_at) WHERE status = 'pending';

CREATE TABLE import_items (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	batch_id UUID NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
	item_number INTEGER NOT NULL CHECK (item_number > 0),
	document_data JSONB NOT NULL,
	file_name TEXT,
	staged_path TEXT,
	file_sha256 CHAR(64),
	duplicate_documents JSONB NOT NULL DEFAULT '[]'::JSONB,
	action TEXT NOT NULL DEFAULT 'pending' CHECK (action IN ('pending', 'skip', 'create', 'attach')),
	target_document_id BIGINT REFERENCES documents(id) ON DELETE SET NULL,
	error TEXT,
	UNIQUE (batch_id, item_number),
	CHECK ((file_name IS NULL) = (staged_path IS NULL))
);

CREATE INDEX import_items_batch_idx ON import_items(batch_id, item_number);
