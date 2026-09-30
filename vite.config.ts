import { cloudflare } from '@cloudflare/vite-plugin';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// vite-plugin-svelte adds its optimizer config to every environment, which
// breaks dependency optimization in the Worker environment. The Worker has
// no Svelte code, so the plugin only applies to the client.
const clientOnly = svelte().map((plugin) => ({
	...plugin,
	applyToEnvironment: (environment: { name: string }) => environment.name === 'client'
}));

export default defineConfig({
	plugins: [clientOnly, cloudflare()]
});
