ALTER TABLE users
	ADD COLUMN totp_secret TEXT,
	ADD COLUMN totp_pending_secret TEXT,
	ADD COLUMN totp_pending_expires_at TIMESTAMPTZ,
	ADD COLUMN totp_last_counter BIGINT;