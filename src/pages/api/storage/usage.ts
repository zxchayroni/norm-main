import type { APIRoute } from 'astro';
import { lstat, readdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { storageRoot } from '../../../lib/server/storage';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

async function directorySize(directory: string): Promise<number> {
	const entries = await readdir(directory, { withFileTypes: true });
	let total = 0;
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) total += await directorySize(entryPath);
		else if (entry.isFile()) total += (await lstat(entryPath)).size;
	}
	return total;
}

export const GET: APIRoute = async ({ locals }) => {
	if (!locals.user) {
		return new Response(JSON.stringify({ error: 'Требуется авторизация.' }), { status: 401, headers: jsonHeaders });
	}

	try {
		const root = storageRoot();
		const [filesystem, archiveBytes] = await Promise.all([statfs(root), directorySize(root)]);
		const totalBytes = filesystem.blocks * filesystem.bsize;
		const freeBytes = filesystem.bavail * filesystem.bsize;
		const usedBytes = Math.max(totalBytes - filesystem.bfree * filesystem.bsize, 0);
		return new Response(JSON.stringify({
			archiveBytes,
			totalBytes,
			freeBytes,
			usedBytes,
			usedPercent: totalBytes > 0 ? Math.min(100, Math.round((usedBytes / totalBytes) * 1000) / 10) : 0,
		}), { headers: jsonHeaders });
	} catch (error) {
		console.error('Unable to read archive storage usage:', error);
		return new Response(JSON.stringify({ error: 'Не удалось получить сведения о хранилище.' }), {
			status: 503,
			headers: jsonHeaders,
		});
	}
};
