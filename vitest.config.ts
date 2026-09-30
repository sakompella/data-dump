import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// Kept apart from vite.config.ts so tests do not start the Cloudflare plugin.
// The Svelte plugin compiles components for jsdom tests.
export default defineConfig({
	plugins: [svelte()],
	// Svelte's browser build, so components can mount in jsdom.
	resolve: { conditions: ['browser'] },
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
