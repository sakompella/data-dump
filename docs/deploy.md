# Deploy

data-dump is one Cloudflare Worker. It serves the web app as static assets and the API at `/api/*`.
Each user's data lives in one SQLite-backed Durable Object.

Do these steps once, by hand. Nothing in the repo runs them.

## 1. Put Cloudflare Access in front of the Worker

Static assets do not pass through the Worker, so Access must cover the whole site, not only `/api/*`.
Checked against the current Cloudflare docs ("Workers > Configuration > Cloudflare Access").

Recommended: protect the Worker itself. This covers its routes, Custom Domains, the `workers.dev` name and preview/version URLs.

1. Deploy once (step 3) so the Worker exists. Until Access is on, the API answers 401 to everyone, and the app shell is public.
2. In the Cloudflare dashboard, open Workers & Pages, select `data-dump`, then the **Access** tab.
3. Select **Protect this Worker behind Access**, then choose **All traffic**.
4. Pick an authentication policy that allows only you (for example your email address). Apply.
5. Copy the **Audience (AUD) tag**: Zero Trust > Access controls > Applications > Configure (on the new application) > Additional settings > Application Audience (AUD) Tag.
6. Copy your **team domain**, for example `https://<your-team>.cloudflareaccess.com`. Use exactly this origin, with no path and no trailing slash. Any other form makes every request answer 401.

Alternative: a hostname-based self-hosted Access application for one URL (path left empty).
It protects only that exact URL. `workers.dev` and preview/version URLs stay reachable and serve the app shell (the API still refuses them).
If you use a custom domain with this option, set `"workers_dev": false` and `"preview_urls": false` in `wrangler.jsonc`.

The Worker also checks the `Cf-Access-Jwt-Assertion` token itself. Without valid settings it refuses every request.

## 2. Set the values in `wrangler.jsonc`

Under `vars`:

- `ACCESS_TEAM_DOMAIN`: the team domain from step 1.
- `ACCESS_AUD`: the AUD tag from step 1.
- `CHATGPT_MODEL`: the model used to split rambles. `gpt-5-mini` is only an example; it is not checked.
  Which models a ChatGPT plan accepts is up to OpenAI. While it is empty, rambles are not split.

Do not set `DEV_USER_ID` here. It only works in `pnpm dev`. `pnpm preview` answers 401 everywhere, because it has no Access token.

## 3. Deploy

```sh
pnpm install
pnpm build && pnpm exec wrangler deploy
```

The first deploy creates the `UserData` Durable Object class through the migration in `wrangler.jsonc`.

## 4. Connect ChatGPT

Open the site, then `/connect`, and follow the steps. The sign-in stays in that browser.
The Worker never sees it.

## Existing data

No data migration is needed. The earlier R2-based version was never deployed, and this version starts with empty Durable Object storage.

## Local development

```sh
cp .dev.vars.example .dev.vars
pnpm dev
```

`DEV_USER_ID` in `.dev.vars` stands in for Access. Local data lives in `.wrangler/`.

## Check a build without deploying

```sh
pnpm build && pnpm exec wrangler deploy --dry-run
```
