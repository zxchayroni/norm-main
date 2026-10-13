import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseUpload } from '../src/lib/server/storage.ts';

const testStorage = await mkdtemp(path.join(process.cwd(), '.test-storage-'));
process.env.ARCHIVE_STORAGE_DIR = testStorage;

after(async () => {
	await rm(testStorage, { recursive: true, force: true });
});

test('parses a PDF upload, validates its signature, and calculates its digest', async () => {
	const form = new FormData();
	form.set('fileKind', 'Подписанный скан');
	form.set('comment', 'Проверка подписи');
	form.set('file', new File([Buffer.from('%PDF-1.7\narchive')], 'приказ.pdf', { type: 'application/pdf' }));

	const upload = await parseUpload(new Request('http://localhost/api/upload', { method: 'POST', body: form }));
	assert.equal(upload.originalName, 'приказ.pdf');
	assert.equal(upload.extension, 'pdf');
	assert.equal(upload.mimeType, 'application/pdf');
	assert.equal(upload.fileKind, 'Подписанный скан');
	assert.equal(upload.comment, 'Проверка подписи');
	assert.equal(upload.fileSize, Buffer.byteLength('%PDF-1.7\narchive'));
	assert.match(upload.sha256, /^[a-f0-9]{64}$/);
	await rm(upload.temporaryPath, { force: true });
});

test('rejects file content whose signature does not match its extension', async () => {
	const form = new FormData();
	form.set('file', new File([Buffer.from('not a pdf')], 'document.pdf', { type: 'application/pdf' }));
	await assert.rejects(
		parseUpload(new Request('http://localhost/api/upload', { method: 'POST', body: form })),
		/Содержимое файла не соответствует расширению/,
	);
	const temporaryFiles = await readdir(path.join(testStorage, '.tmp'));
	assert.deepEqual(temporaryFiles, []);
});

test('rejects unsupported file extensions', async () => {
	const form = new FormData();
	form.set('file', new File([Buffer.from('payload')], 'payload.exe'));
	await assert.rejects(
		parseUpload(new Request('http://localhost/api/upload', { method: 'POST', body: form })),
		/Недопустимый формат/,
	);
});
