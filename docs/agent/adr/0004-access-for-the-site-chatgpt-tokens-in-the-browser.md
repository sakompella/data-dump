# Cloudflare Access gates the site; ChatGPT tokens stay in the browser

Cloudflare Access protects the whole Worker. The Worker also verifies the `Cf-Access-Jwt-Assertion` token itself (signature, issuer, audience, `exp`, `sub`) and refuses everything when its settings are missing; the verified `sub` selects the user's Durable Object. `DEV_USER_ID` stands in for Access only in `vite dev`.

ChatGPT sign-in follows Pi's direct "Sign in with ChatGPT" flow (dynamic client id, `chatgpt.tokens.use.direct` scope). The redirect goes to `127.0.0.1`, which a hosted site cannot receive, so the user pastes the final address back once. Tokens live in `localStorage`; refresh, login, and disconnect share one `navigator.locks` lock. The browser calls `api.openai.com/v1/responses` directly (OpenAI allows the cross-origin request) and sends only the proposed passages to the Worker. The Worker never sees a token, and there is no API-key path.

## Considered options

- A shared `APP_PASSWORD`: replaced, because it cannot tell users apart and more users are planned.
- Tokens on the server, or an `OPENAI_API_KEY`: rejected so the Worker holds no model credentials.
- The legacy Codex-backend flow with a device code: rejected. It reuses the Codex CLI's client id, and Codex's own prompt tells users to cancel if a website gave them the code.

## Consequences

- A failed split retries only when the app is open in a signed-in browser.
- Same-origin JavaScript can read the tokens, so a strict Content-Security-Policy is worth adding.
- The user states that this use of ChatGPT sign-in is permitted. The research found no explicit grant in the Codex, Pi, or FLUE sources.
