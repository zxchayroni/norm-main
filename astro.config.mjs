// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

const allowedHosts = (process.env.APP_ALLOWED_HOSTS ?? 'localhost,127.0.0.1')
	.split(',')
	.map((host) => host.trim())
	.filter(Boolean);

export default defineConfig({
	output: 'server',
	adapter: node({ mode: 'standalone', bodySizeLimit: 110 * 1024 * 1024 }),
	security: {
		allowedDomains: allowedHosts.map((hostname) => ({ hostname })),
	},
});
