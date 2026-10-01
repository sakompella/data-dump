# One Worker: Hono API plus a plain Svelte SPA, not SvelteKit

The app is one Cloudflare Worker. `src/worker/index.ts` exports the Hono app for `/api/*` and the `UserData` Durable Object class; the Svelte SPA in `src/web/` is served as static assets with single-page-application fallback. Vite builds both through `@cloudflare/vite-plugin`, and `vite dev` runs the Worker, the object, and the SPA together in `workerd`.

SvelteKit was dropped because `@sveltejs/adapter-cloudflare` (7.2.9) generates the Worker entry and has no supported way to export a Durable Object class, and its dev proxy reaches a Durable Object only in another Worker. A throwaway prototype showed this stack works under one `vite dev` and passes `wrangler deploy --dry-run`.

## Consequences

- `vite-plugin-svelte` applies its settings to every Vite environment, which breaks the Worker build; `vite.config.ts` limits it to the client environment.
- svelte-check rejects TypeScript 7, so TypeScript stays on 6.
- Only `/api/*` runs the Worker first. Static assets bypass it, so Cloudflare Access must protect the whole Worker, not only the API (see `docs/deploy.md`).
- Pages need JavaScript: there are no server-rendered forms. Routing is a small history-API router.
