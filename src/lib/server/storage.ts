import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const allowedMimeTypes: Record<string, string> = {
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	pdf: 'application/pdf',
	zip: 'application/zip',
	csv: 'text/csv',
};

export interface ParsedUpload {
	temporaryPath: string;
	originalName: string;
	extension: string;
	mimeType: string;
	fileSize: number;
	sha256: string;
	comment: string;
	fileKind: string;
}

export function storageRoot(): string {
	const configuredRoot = process.env.ARCHIVE_STORAGE_DIR;
	if (!configuredRoot) throw new Error('ARCHIVE_STORAGE_DIR must point to a private, non-public storage directory.');
	return path.resolve(configuredRoot);
}

export function resolveStoredPath(storedPath: string): string {
	const root = storageRoot();
	const absolute = path.resolve(root, storedPath);
	if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error('Stored file path is outside the configured storage directory.');
	return absolute;
}

function cleanOriginalName(name: string): string {
	const leaf = path.basename(name.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
	if (!leaf || leaf === '.' || leaf === '..' || leaf.length > 240) throw new Error('Некорректное имя файла.');
	return leaf;
}

function checkSignature(extension: string, bytes: Buffer): void {
	if (extension === 'csv') return;
	const valid = extension === 'pdf'
		? bytes.subarray(0, 5).toString('ascii') === '%PDF-'
		: bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
	if (!valid) throw new Error('Содержимое файла не соответствует расширению.');
}

export async function parseUpload(
	request: Request,
	allowedExtensions: readonly string[] = ['docx', 'xlsx', 'pdf'],
): Promise<ParsedUpload> {
	const contentType = request.headers.get('content-type') ?? '';
	if (!contentType.toLowerCase().startsWith('multipart/form-data')) throw new Error('Ожидается multipart-загрузка файла.');
	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (contentLength > MAX_FILE_SIZE + 1024 * 1024) throw new Error('Размер запроса превышает допустимые 100 МБ на файл.');
	if (!request.body) throw new Error('В запросе отсутствует тело с файлом.');

	const root = storageRoot();
	const temporaryDirectory = path.join(root, '.tmp');
	await mkdir(temporaryDirectory, { recursive: true });
	const temporaryPath = path.join(temporaryDirectory, `${randomUUID()}.upload`);
	const fields = new Map<string, string>();
	let upload: ParsedUpload | undefined;
	let fileFailure: Error | undefined;
	const uploadTasks: Promise<void>[] = [];

	const parser = Busboy({
		headers: Object.fromEntries(request.headers.entries()),
		defParamCharset: 'utf8',
		limits: { files: 1, fields: 3, fieldSize: 1000, fileSize: MAX_FILE_SIZE },
	});
	parser.on('field', (name, value, info) => {
		if (info.valueTruncated) fileFailure = new Error('Слишком длинное значение поля загрузки.');
		fields.set(name, value);
	});
	parser.on('filesLimit', () => { fileFailure = new Error('За один запрос можно загрузить только один файл.'); });
	parser.on('fieldsLimit', () => { fileFailure = new Error('Слишком много параметров загрузки.'); });
	parser.on('file', (fieldName, file, info) => {
		if (fieldName !== 'file') {
			file.resume();
			fileFailure = new Error('Файл должен передаваться в поле "file".');
			return;
		}

		const task = (async () => {
			const originalName = cleanOriginalName(info.filename);
			const extension = path.extname(originalName).slice(1).toLowerCase();
			if (!allowedExtensions.includes(extension) || !Object.hasOwn(allowedMimeTypes, extension)) {
				file.resume();
				throw new Error(`Недопустимый формат. Разрешены: ${allowedExtensions.map((item) => `.${item}`).join(', ')}.`);
			}

			const digest = createHash('sha256');
			let fileSize = 0;
			let firstBytes = Buffer.alloc(0);
			const meter = new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					fileSize += chunk.length;
					if (firstBytes.length < 8) firstBytes = Buffer.concat([firstBytes, chunk.subarray(0, 8 - firstBytes.length)]);
					digest.update(chunk);
					callback(null, chunk);
				},
				flush(callback) {
					try {
						checkSignature(extension, firstBytes);
						callback();
					} catch (error) {
						callback(error instanceof Error ? error : new Error('Некорректное содержимое файла.'));
					}
				},
			});

			await pipeline(file, meter, createWriteStream(temporaryPath, { flags: 'wx' }));
			if (file.truncated) throw new Error('Файл превышает допустимый размер 100 МБ.');

			const fileKind = fields.get('fileKind') ?? 'Исходный документ';
			const comment = fields.get('comment') ?? '';
			if (comment.length > 1000 || fileKind.length > 100) throw new Error('Комментарий или тип файла слишком длинный.');
			upload = {
				temporaryPath,
				originalName,
				extension,
				mimeType: allowedMimeTypes[extension],
				fileSize,
				sha256: digest.digest('hex'),
				comment,
				fileKind,
			};
		})().catch((error: unknown) => {
			fileFailure = error instanceof Error ? error : new Error('Не удалось принять файл.');
		});
		uploadTasks.push(task);
	});

	const nodeBody = Readable.fromWeb(request.body as import('node:stream/web').ReadableStream<Uint8Array>);
	try {
		await Promise.all([
			pipeline(nodeBody, parser),
			(async () => {
				await new Promise<void>((resolve, reject) => {
					parser.once('close', resolve);
					parser.once('error', reject);
				});
			})(),
		]);
		await Promise.all(uploadTasks);
		if (fileFailure) throw fileFailure;
		if (!upload) throw new Error('В запросе отсутствует файл.');
		return upload;
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw error;
	}
}

export async function moveUploadIntoStorage(upload: ParsedUpload): Promise<string> {
	const relativePath = path.join(upload.sha256.slice(0, 2), `${randomUUID()}.${upload.extension}`);
	const finalPath = resolveStoredPath(relativePath);
	await mkdir(path.dirname(finalPath), { recursive: true });
	await rename(upload.temporaryPath, finalPath);
	return relativePath;
}

export async function removeStoredPath(storedPath: string): Promise<void> {
	await rm(resolveStoredPath(storedPath), { force: true });
}
