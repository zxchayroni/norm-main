import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { prepareImport } from '../src/lib/server/import-manifest.ts';
import { resolveStoredPath } from '../src/lib/server/storage.ts';
import type { ParsedUpload } from '../src/lib/server/storage.ts';

const testStorage = await mkdtemp(path.join(os.tmpdir(), 'archive-import-test-'));
process.env.ARCHIVE_STORAGE_DIR = testStorage;

after(async () => {
	await rm(testStorage, { recursive: true, force: true });
});

function crc32(buffer: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Array<{ name: string; content: string | Buffer }>): Buffer {
	const localParts: Buffer[] = [];
	const directoryParts: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, 'utf8');
		const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
		const checksum = crc32(content);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x800, 6);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(content.length, 18);
		local.writeUInt32LE(content.length, 22);
		local.writeUInt16LE(name.length, 26);
		localParts.push(local, name, content);

		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50, 0);
		directory.writeUInt16LE(20, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt16LE(0x800, 8);
		directory.writeUInt32LE(checksum, 16);
		directory.writeUInt32LE(content.length, 20);
		directory.writeUInt32LE(content.length, 24);
		directory.writeUInt16LE(name.length, 28);
		directory.writeUInt32LE(offset, 42);
		directoryParts.push(directory, name);
		offset += local.length + name.length + content.length;
	}
	const directory = Buffer.concat(directoryParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...localParts, directory, end]);
}

async function uploadFile(extension: string, contents: Buffer, name = `manifest.${extension}`): Promise<ParsedUpload> {
	const temporaryPath = path.join(testStorage, `${Date.now()}-${Math.random()}.${extension}`);
	await writeFile(temporaryPath, contents);
	return {
		temporaryPath,
		originalName: name,
		extension,
		mimeType: 'application/octet-stream',
		fileSize: contents.length,
		sha256: '',
		comment: '',
		fileKind: 'Исходный документ',
	};
}

test('parses CSV manifest values and normalizes Russian dates', async () => {
	const upload = await uploadFile('csv', Buffer.from('Название,Номер,Дата,Теги\nПриказ,А-1,31.12.2024,"архив; право"', 'utf8'));
	try {
		const result = await prepareImport(upload, 'csv-batch');
		assert.equal(result.items.length, 1);
		assert.equal(result.items[0].title, 'Приказ');
		assert.equal(result.items[0].number, 'А-1');
		assert.equal(result.items[0].date, '2024-12-31');
		assert.deepEqual(result.items[0].tags, ['архив', 'право']);
		assert.equal(result.items[0].error, null);
	} finally {
		await rm(upload.temporaryPath, { force: true });
	}
});

test('parses XLSX dates and rejects invalid manifest dates', async () => {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet('Документы');
	sheet.addRow(['Название', 'Дата']);
	sheet.addRow(['Положение', new Date(Date.UTC(2025, 0, 15))]);
	sheet.addRow(['Регламент', '31.02.2025']);
	const upload = await uploadFile('xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
	try {
		const result = await prepareImport(upload, 'xlsx-batch');
		assert.equal(result.items[0].date, '2025-01-15');
		assert.equal(result.items[0].error, null);
		assert.match(result.items[1].error ?? '', /некорректная дата документа/);
	} finally {
		await rm(upload.temporaryPath, { force: true });
	}
});

test('stages ZIP attachments referenced by the manifest', async () => {
	const upload = await uploadFile('zip', zip([
		{ name: 'manifest.csv', content: 'Название,Файл\nПриказ,docs/order.pdf' },
		{ name: 'docs/order.pdf', content: '%PDF-1.7\narchive' },
	]), 'import.zip');
	try {
		const result = await prepareImport(upload, 'zip-batch');
		assert.equal(result.items.length, 1);
		assert.equal(result.items[0].fileName, 'order.pdf');
		assert.equal(result.items[0].title, 'Приказ');
		assert.ok(result.items[0].stagedPath);
		assert.equal((await readFile(resolveStoredPath(result.items[0].stagedPath!))).toString(), '%PDF-1.7\narchive');
		for (const stagedPath of result.stagedFiles) await rm(resolveStoredPath(stagedPath), { force: true });
	} finally {
		await rm(upload.temporaryPath, { force: true });
	}
});

test('rejects ZIP path traversal without staging files', async () => {
	const upload = await uploadFile('zip', zip([
		{ name: '../manifest.csv', content: 'Название\nПриказ' },
	]), 'unsafe.zip');
	try {
		await assert.rejects(prepareImport(upload, 'unsafe-batch'), /переходом за пределы папки/);
	} finally {
		await rm(upload.temporaryPath, { force: true });
	}
});
