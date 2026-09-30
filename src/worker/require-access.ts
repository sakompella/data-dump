import { createMiddleware } from 'hono/factory';
import { identify } from './access';
import type { AppEnv } from './env';

type Keys = NonNullable<Parameters<typeof identify>[0]['keys']>;

// Puts the verified user on the context. Anything else gets 401 and no data.
export const requireAccess = ({ dev, keys }: { dev: boolean; keys?: Keys }) =>
	createMiddleware<AppEnv>(async (c, next) => {
		const identity = await identify({
			dev,
			env: c.env,
			token: c.req.header('cf-access-jwt-assertion') ?? null,
			keys
		});

		if (!identity.ok) {
			console.warn(`access denied: ${identity.reason}`);

			return c.json({ error: 'unauthorized' }, 401);
		}

		c.set('userId', identity.userId);
		await next();
	});
