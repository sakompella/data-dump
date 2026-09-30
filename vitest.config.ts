import { defineConfig } from 'vitest/config';

// Kept apart from vite.config.ts so tests do not start the Cloudflare plugin.
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
