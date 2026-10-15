export function assertSameOrigin(request: Request): boolean {
	const origin = request.headers.get('origin');
	if (!origin) return false;

	try {
		const originUrl = new URL(origin);
		const requestUrl = new URL(request.url);
		if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false;
		if (originUrl.origin === requestUrl.origin) return true;
		if (originUrl.host !== requestUrl.host) return false;

		const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',')[0].trim();
		return forwardedProtocol === originUrl.protocol.slice(0, -1);
	} catch {
		return false;
	}
}
