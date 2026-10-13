import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';

const periodSeconds = 30;

function encryptionKey(): Buffer {
	const value = process.env.TOTP_ENCRYPTION_KEY ?? '';
	if (!/^[a-f0-9]{64}$/i.test(value)) {
		throw new Error('TOTP_ENCRYPTION_KEY must be a 32-byte hexadecimal key.');
	}
	return Buffer.from(value, 'hex');
}

export function createTotp(label: string): TOTP {
	return new TOTP({ issuer: 'НормАрхив', label, secret: new Secret({ size: 20 }), digits: 6, period: periodSeconds });
}

export function encryptTotpSecret(secret: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
	const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
	return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptTotpSecret(value: string): string {
	const [ivValue, tagValue, encryptedValue, extra] = value.split('.');
	if (!ivValue || !tagValue || !encryptedValue || extra !== undefined) throw new Error('Invalid encrypted TOTP secret.');
	const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivValue, 'base64url'));
	decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
	return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

export function matchingTotpCounter(secret: string, token: string, timestamp = Date.now()): number | null {
	if (!/^\d{6}$/.test(token)) return null;
	const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: periodSeconds });
	const delta = totp.validate({ token, timestamp, window: 1 });
	return delta === null ? null : TOTP.counter({ timestamp, period: periodSeconds }) + delta;
}