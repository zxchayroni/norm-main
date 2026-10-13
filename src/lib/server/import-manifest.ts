import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ExcelJS from 'exceljs';
import yauzl from 'yauzl';
import type { ParsedUpload } from './storage.ts';
import { resolveStoredPath } from './storage.ts';

const MAX_ARCHIVE_ENTRIES = 2000;
const MAX_ARCHIVE_EXPANDED_SIZE = 1024 * 1024 * 1024;
const MAX_MANIFEST_SIZE = 10 * 1024 * 1024;
const MAX_DOC_FILE_SIZE = 100 * 1024 * 1024;
const acceptedFileExtensions = new Set(['docx', 'xlsx', 'pdf']);

export interface ImportCandidate {
	title: string;
	number: string;
	date: string | null;
	effectiveDate: string | null;
	expiryDate: string | null;
	type: string;
	status: string;
	department: string;
	description: string;
	tags: string[];
	fileKind: string;
	fileName: string | null;
	stagedPath: string | null;
	sha256: string | null;
	error: string | null;
}

export interface PreparedImport {
	items: ImportCandidate[];
	stagedFiles: string[];
}

function normalizeHeader(value: string): string {
	return value.trim().toLocaleLowerCase('ru').replace(/[\s_-]+/g, '');
}

function cellString(value: ExcelJS.CellValue, numberFormat = ''): string {
	if (value === null || value === undefined) return '';
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	if (typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text.trim();
	if (typeof value === 'object' && 'result' in value) return cellString(value.result as ExcelJS.CellValue, numberFormat);
	if (typeof value === 'number' && /[dmy]/i.test(numberFormat)) {
		const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86400000));
		return date.toISOString().slice(0, 10);
	}
	return String(value).trim();
}

function normalizeDate(value: string): string | null {
	if (!value) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		const date = new Date(`${value}T00:00:00.000Z`);
		return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value ? value : null;
	}
	const match = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
	if (!match) return null;
	const date = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
	return normalizeDate(date);
}

function safeArchiveName(value: string): string {
	const normalized = value.replaceAll('\\', '/');
	if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
		throw new Error('В архиве обнаружено недопустимое имя элемента.');
	}
	const segments = normalized.split('/');
	if (segments.some((segment) => segment === '..' || segment === '.')) {
		throw new Error('В архиве обнаружен путь с переходом за пределы папки.');
	}
	return segments.filter(Boolean).join('/');
}

function mapManifestRows(rows: string[][], fileLookup: Map<string, { path: string; hash: string }>): ImportCandidate[] {
	if (!rows.length) throw new Error('Таблица импорта пуста.');
	const aliases: Record<string, string[]> = {
		file: ['file', 'filename', 'файл', 'имяфайла', 'вложение'],
		title: ['title', 'name', 'название', 'наименование', 'названиедокумента'],
		number: ['number', 'docnumber', 'номер', 'номердокумента'],
		date: ['date', 'docdate', 'дата', 'датадокумента'],
		effectiveDate: ['effectivedate', 'датавступлениявсилу'],
		expiryDate: ['expirydate', 'датазавершениядействия', 'действуетдо'],
		type: ['type', 'doctype', 'вид', 'виддокумента', 'типдокумента'],
		status: ['status', 'статус'],
		department: ['department', 'подразделение'],
		description: ['description', 'описание'],
		tags: ['tags', 'теги', 'ключевыеслова'],
		fileKind: ['filekind', 'типфайла'],
	};
	const headers = rows[0].map(normalizeHeader);
	const columns = new Map<string, number>();
	for (const [field, names] of Object.entries(aliases)) {
		const index = headers.findIndex((header) => names.includes(header));
		if (index >= 0) columns.set(field, index);
	}
	if (!columns.has('title')) throw new Error('В таблице импорта требуется колонка «Название» или «title».');

	return rows.slice(1).flatMap((row, index) => {
		if (!row.some((value) => value.trim())) return [];
		const get = (key: string) => row[columns.get(key) ?? -1]?.trim() ?? '';
		const title = get('title');
		let error: string | null = null;
		if (!title || title.length > 300) error = `Строка ${index + 2}: укажите название длиной до 300 символов.`;
		const dateValue = get('date');
		const effectiveDateValue = get('effectiveDate');
		const expiryDateValue = get('expiryDate');
		if (dateValue && !normalizeDate(dateValue)) error = `Строка ${index + 2}: некорректная дата документа.`;
		if (effectiveDateValue && !normalizeDate(effectiveDateValue)) error = `Строка ${index + 2}: некорректная дата вступления в силу.`;
		if (expiryDateValue && !normalizeDate(expiryDateValue)) error = `Строка ${index + 2}: некорректная дата окончания действия.`;

		const fileName = get('file');
		const attached = fileName ? fileLookup.get(fileName.replaceAll('\\', '/')) : undefined;
		if (fileName && !attached) error = `Строка ${index + 2}: файл «${fileName}» отсутствует в архиве.`;
		return [{
			title,
			number: get('number').slice(0, 100),
			date: dateValue ? normalizeDate(dateValue) : null,
			effectiveDate: effectiveDateValue ? normalizeDate(effectiveDateValue) : null,
			expiryDate: expiryDateValue ? normalizeDate(expiryDateValue) : null,
			type: (get('type') || 'Иной документ').slice(0, 100),
			status: (get('status') || 'Проект').slice(0, 100),
			department: get('department').slice(0, 200),
			description: get('description').slice(0, 5000),
			tags: get('tags').split(/[,;]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 30),
			fileKind: (get('fileKind') || 'Исходный документ').slice(0, 100),
			fileName: attached ? path.posix.basename(fileName.replaceAll('\\', '/')) : null,
			stagedPath: attached?.path ?? null,
			sha256: attached?.hash ?? null,
			error,
		}];
	});
}

async function readManifest(buffer: Buffer, extension: string): Promise<string[][]> {
	const workbook = new ExcelJS.Workbook();
	if (extension === 'csv') {
		await workbook.csv.read(Readable.from(buffer));
	} else {
		await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
	}
	const sheet = workbook.worksheets[0];
	if (!sheet) throw new Error('В файле не найдена таблица для импорта.');
	const rows: string[][] = [];
	sheet.eachRow({ includeEmpty: false }, (row) => {
		rows.push(Array.from({ length: Math.max(row.cellCount, sheet.columnCount) }, (_, index) => {
			const cell = row.getCell(index + 1);
			return cellString(cell.value, cell.numFmt ?? '');
		}));
	});
	return rows;
}

function openArchive(filePath: string): Promise<yauzl.ZipFile> {
	return new Promise((resolve, reject) => {
		yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, decodeStrings: true }, (error, zip) => {
			if (error instanceof Error && error.message.startsWith('invalid relative path:')) {
				reject(new Error('В архиве обнаружен путь с переходом за пределы папки.'));
			} else if (error) reject(error);
			else if (!zip) reject(new Error('Не удалось прочитать ZIP-архив.'));
			else resolve(zip);
		});
	});
}

export async function prepareImport(upload: ParsedUpload, batchId: string): Promise<PreparedImport> {
	if (upload.extension === 'csv' || upload.extension === 'xlsx') {
		const fileBuffer = await import('node:fs/promises').then(({ readFile }) => readFile(upload.temporaryPath));
		if (fileBuffer.byteLength > MAX_MANIFEST_SIZE) throw new Error('Таблица импорта не должна превышать 10 МБ.');
		const rows = await readManifest(fileBuffer, upload.extension);
		return { items: mapManifestRows(rows, new Map()), stagedFiles: [] };
	}
	if (upload.extension !== 'zip') throw new Error('Для импорта используйте CSV, XLSX или ZIP.');

	const zip = await openArchive(upload.temporaryPath);
	const stagingDirectory = path.join('.imports', batchId);
	await mkdir(resolveStoredPath(stagingDirectory), { recursive: true });
	const fileLookup = new Map<string, { path: string; hash: string; name: string }>();
	const stagedFiles: string[] = [];
	let manifest: { buffer: Buffer; extension: string } | undefined;
	let entryCount = 0;
	let expandedSize = 0;

	try {
		await new Promise<void>((resolve, reject) => {
			let finished = false;
			const fail = (error: Error) => {
				if (finished) return;
				finished = true;
				zip.close();
				reject(error.message.startsWith('invalid relative path:')
					? new Error('В архиве обнаружен путь с переходом за пределы папки.')
					: error);
			};
			zip.on('error', fail);
			zip.on('end', () => {
				if (finished) return;
				finished = true;
				resolve();
			});
			zip.on('entry', (entry) => {
				if (finished) return;
				(async () => {
					entryCount += 1;
					expandedSize += entry.uncompressedSize;
					if (entryCount > MAX_ARCHIVE_ENTRIES || expandedSize > MAX_ARCHIVE_EXPANDED_SIZE) {
						throw new Error('ZIP-архив превышает лимит по количеству файлов или распакованному объёму.');
					}
					const entryName = safeArchiveName(entry.fileName);
					if (entryName.endsWith('/')) {
						zip.readEntry();
						return;
					}
					const extension = path.posix.extname(entryName).slice(1).toLowerCase();
					const baseName = path.posix.basename(entryName).toLowerCase();
					const isManifest = (baseName === 'manifest.csv' && extension === 'csv') ||
						(baseName === 'manifest.xlsx' && extension === 'xlsx');
					if (isManifest) {
						if (manifest) throw new Error('В ZIP-архиве допускается только один файл manifest.csv или manifest.xlsx.');
						if (entry.uncompressedSize > MAX_MANIFEST_SIZE) throw new Error('Таблица импорта в ZIP превышает 10 МБ.');
						const chunks: Buffer[] = [];
						let size = 0;
						await new Promise<void>((entryResolve, entryReject) => {
							zip.openReadStream(entry, (error, stream) => {
								if (error || !stream) return entryReject(error ?? new Error('Не удалось прочитать manifest.'));
								stream.on('data', (chunk: Buffer) => {
									size += chunk.length;
									if (size > MAX_MANIFEST_SIZE) stream.destroy(new Error('Таблица импорта в ZIP превышает 10 МБ.'));
									else chunks.push(chunk);
								});
								stream.once('error', entryReject);
								stream.once('end', entryResolve);
							});
						});
						manifest = { buffer: Buffer.concat(chunks), extension };
					} else if (acceptedFileExtensions.has(extension)) {
						if (entry.uncompressedSize > MAX_DOC_FILE_SIZE) throw new Error(`Файл «${entryName}» превышает 100 МБ.`);
						if (fileLookup.has(entryName)) throw new Error(`В архиве повторяется имя файла «${entryName}».`);
						const stagedPath = path.join(stagingDirectory, `${randomUUID()}.${extension}`);
						const absolutePath = resolveStoredPath(stagedPath);
						const hash = createHash('sha256');
						let total = 0;
						let prefix = Buffer.alloc(0);
						const checker = new Transform({
							transform(chunk: Buffer, _encoding, callback) {
								total += chunk.length;
								if (total > MAX_DOC_FILE_SIZE) {
									callback(new Error(`Файл «${entryName}» превышает 100 МБ.`));
									return;
								}
								hash.update(chunk);
								if (prefix.length < 8) prefix = Buffer.concat([prefix, chunk.subarray(0, 8 - prefix.length)]);
								callback(null, chunk);
							},
							flush(callback) {
								const valid = extension === 'pdf'
									? prefix.subarray(0, 5).toString('ascii') === '%PDF-'
									: prefix[0] === 0x50 && prefix[1] === 0x4b;
								if (!valid) callback(new Error(`Содержимое файла «${entryName}» не соответствует расширению.`));
								else callback();
							},
						});
						await mkdir(path.dirname(absolutePath), { recursive: true });
						await new Promise<void>((entryResolve, entryReject) => {
							zip.openReadStream(entry, (error, stream) => {
								if (error || !stream) return entryReject(error ?? new Error(`Не удалось прочитать «${entryName}».`));
								pipeline(stream, checker, createWriteStream(absolutePath, { flags: 'wx' })).then(entryResolve, entryReject);
							});
						});
						fileLookup.set(entryName, { path: stagedPath, hash: hash.digest('hex'), name: path.posix.basename(entryName) });
						stagedFiles.push(stagedPath);
					}
					zip.readEntry();
				})().catch((error: unknown) => fail(error instanceof Error ? error : new Error('Не удалось прочитать ZIP-архив.')));
			});
			zip.readEntry();
		});

		if (manifest) {
			const rows = await readManifest(manifest.buffer, manifest.extension);
			const items = mapManifestRows(rows, fileLookup);
			const attachedPaths = new Set(items.map((item) => item.stagedPath).filter((item): item is string => Boolean(item)));
			for (const [name, file] of fileLookup) {
				if (!attachedPaths.has(file.path)) {
					items.push({
						title: path.posix.basename(name, path.posix.extname(name)),
						number: '', date: null, effectiveDate: null, expiryDate: null,
						type: 'Иной документ', status: 'Проект', department: '', description: '',
						tags: [], fileKind: 'Исходный документ', fileName: file.name,
						stagedPath: file.path, sha256: file.hash, error: null,
					});
				}
			}
			return { items, stagedFiles };
		}

		if (!fileLookup.size) throw new Error('Архив не содержит поддерживаемых документов или таблицы manifest.csv/manifest.xlsx.');
		const items = [...fileLookup.entries()].map(([name, file]) => ({
			title: path.posix.basename(name, path.posix.extname(name)).slice(0, 300),
			number: '', date: null, effectiveDate: null, expiryDate: null,
			type: 'Иной документ', status: 'Проект', department: '', description: '',
			tags: [], fileKind: 'Исходный документ', fileName: file.name,
			stagedPath: file.path, sha256: file.hash, error: null,
		}));
		return { items, stagedFiles };
	} catch (error) {
		for (const stagedPath of stagedFiles) await rm(resolveStoredPath(stagedPath), { force: true });
		throw error;
	} finally {
		zip.close();
	}
}
