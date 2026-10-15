import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSameOrigin } from '../src/lib/server/origin.ts';

test('accepts an exact same-origin request', () => {
	const request = new Request('https://archive.example/api/auth/login', {
		headers: { origin: 'https://archive.example' },
	});
	assert.equal(assertSameOrigin(request), true);
});

test('accepts the external HTTPS origin forwarded to an HTTP app server', () => {
	const request = new Request('http://archive.example/api/auth/login', {
		headers: {
			origin: 'https://archive.example',
			'x-forwarded-proto': 'https',
		},
	});
	assert.equal(assertSameOrigin(request), true);
});

test('rejects a different host behind a reverse proxy', () => {
	const request = new Request('http://archive.example/api/auth/login', {
		headers: {
			origin: 'https://attacker.example',
			'x-forwarded-proto': 'https',
		},
	});
	assert.equal(assertSameOrigin(request), false);
});

test('rejects mismatched or missing forwarded protocols', () => {
	const mismatched = new Request('http://archive.example/api/auth/login', {
		headers: {
			origin: 'https://archive.example',
			'x-forwarded-proto': 'http',
		},
	});
	const missing = new Request('http://archive.example/api/auth/login', {
		headers: { origin: 'https://archive.example' },
	});
	assert.equal(assertSameOrigin(mismatched), false);
	assert.equal(assertSameOrigin(missing), false);
});
