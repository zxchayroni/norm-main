ALTER TABLE users
	ADD COLUMN totp_failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (totp_failed_attempts >= 0),
	ADD COLUMN totp_pending_attempts INTEGER NOT NULL DEFAULT 0 CHECK (totp_pending_attempts >= 0);