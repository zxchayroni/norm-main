import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Secret, TOTP } from 'otpauth';
import { createTotp, decryptTotpSecret, encryptTotpSecret, matchingTotpCounter } from '../src/lib/server/totp.ts';

test('validates TOTP codes and rejects malformed or incorrect codes', () => {
	const timestamp = 1_700_000_000_000;
	const secret = new Secret({ size: 20 }).base32;
	const token = new TOTP({ secret: Secret.fromBase32(secret) }).generate({ timestamp });
	assert.equal(matchingTotpCounter(secret, token, timestamp), TOTP.counter({ timestamp }));
	assert.equal(matchingTotpCounter(secret, 'abc123', timestamp), null);
	assert.equal(matchingTotpCounter(secret, String((Number(token) + 1) % 1_000_000).padStart(6, '0'), timestamp), null);
});

test('encrypts TOTP secrets and refuses to decrypt tampered ciphertext', () => {
	const previousKey = process.env.TOTP_ENCRYPTION_KEY;
	process.env.TOTP_ENCRYPTION_KEY = 'a'.repeat(64);
	try {
		const secret = createTotp('test-user').secret.base32;
		const encrypted = encryptTotpSecret(secret);
		assert.notEqual(encrypted, secret);
		assert.equal(decryptTotpSecret(encrypted), secret);
		const [iv, tag, ciphertext] = encrypted.split('.');
		assert.throws(() => decryptTotpSecret(`${iv}.${tag}.${ciphertext.slice(0, -1)}A`));
	} finally {
		if (previousKey === undefined) delete process.env.TOTP_ENCRYPTION_KEY;
		else process.env.TOTP_ENCRYPTION_KEY = previousKey;
	}
});