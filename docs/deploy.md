# Deploy

data-dump is one Cloudflare Worker. It serves the web app as static assets and the API at `/api/*`.
Each user's data lives in one SQLite-backed Durable Object.

Do these steps once, by hand. Nothing in the repo runs them.

## 1. Put Cloudflare Access in front of the whole hostname

Static assets do not pass through the Worker, so Access must cover every path, not only `/api/*`.

1. In Cloudflare Zero Trust, open Access > Applications and add a self-hosted application.
2. Set the domain to the Worker's hostname (for example the `workers.dev` name, or your own domain). Leave the path empty.
3. Add a policy that allows only you (for example your email address).
4. Copy the application's **Audience (AUD) tag**.
5. Copy your **team domain**, for example `https://<your-team>.cloudflareaccess.com`.

The Worker also checks the `Cf-Access-Jwt-Assertion` token itself. Without valid settings it refuses every request.

## 2. Set the values in `wrangler.jsonc`

Under `vars`:

- `ACCESS_TEAM_DOMAIN`: the team domain from step 1.
- `ACCESS_AUD`: the AUD tag from step 1.
- `CHATGPT_MODEL`: the model used to split rambles, for example `gpt-5-mini`.
  Which models a ChatGPT plan accepts is up to OpenAI. While it is empty, rambles are not split.

Do not set `DEV_USER_ID` here. It only works in `pnpm dev`.

## 3. Deploy

```sh
pnpm install
pnpm build && pnpm exec wrangler deploy
```

The first deploy creates the `UserData` Durable Object class through the migration in `wrangler.jsonc`.

## 4. Connect ChatGPT

Open the site, then `/connect`, and follow the steps. The sign-in stays in that browser.
The Worker never sees it.

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
