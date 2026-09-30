import { zValidator } from '@hono/zod-validator';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { MAX_PROPOSALS, proposedThought } from '../shared/proposals';
import { rambleId, revision, thoughtId, todoState } from '../shared/schemas';
import type { AppEnv } from './env';
import { requireAccess } from './require-access';
import type { EditResult } from './rules';

// Text is stored in one SQLite row; these keep a row well under the 2 MB limit.
const MAX_TEXT_CHARS = 500_000;

const MAX_LABEL_CHARS = 200;

const MAX_REQUEST_BYTES = 2_000_000;

const text = z.string().max(MAX_TEXT_CHARS);

const draftSave = z.object({ id: rambleId, body: text, base: revision.nullable() });

const rambleRef = z.object({ id: rambleId });

const splitFinish = z.object({
	id: rambleId,
	revision,
	proposals: z.array(proposedThought).max(MAX_PROPOSALS)
});

const rambleEdit = z.object({ body: text, revision });

const thoughtEdit = z.object({
	revision,
	label: z.string().trim().max(MAX_LABEL_CHARS).optional(),
	body: text.optional(),
	todo: todoState.optional()
});

const revisionOnly = z.object({ revision });

const idParam = <Id extends z.ZodType>(id: Id) => z.object({ id });

const invalid = (
	result: { success: boolean },
	c: { json(body: { error: string }, status: 400): Response }
) => (result.success ? undefined : c.json({ error: 'invalid request' }, 400));

export function createApp({
	dev,
	keys
}: {
	dev: boolean;
	keys?: Parameters<typeof requireAccess>[0]['keys'];
}) {
	const app = new Hono<AppEnv>();

	return app
		.use(
			'/api/*',
			requireAccess({ dev, keys }),
			bodyLimit({
				maxSize: MAX_REQUEST_BYTES,
				onError: (c) => c.json({ error: 'request too large' }, 413)
			})
		)
		.get('/api/config', (c) => c.json({ chatgptModel: c.env.CHATGPT_MODEL || null }))
		.get('/api/home', async (c) => c.json(await c.env.USER_DATA.getByName(c.var.userId).home()))
		.put('/api/ramble', zValidator('json', draftSave, invalid), async (c) =>
			c.json(await c.env.USER_DATA.getByName(c.var.userId).saveDraft(c.req.valid('json')))
		)
		.post('/api/ramble/end', zValidator('json', rambleRef, invalid), async (c) =>
			c.json({
				toSplit: await c.env.USER_DATA.getByName(c.var.userId).endRamble(c.req.valid('json').id)
			})
		)
		.post('/api/ramble/split', zValidator('json', splitFinish, invalid), async (c) => {
			const result = await c.env.USER_DATA.getByName(c.var.userId).finishSplit(c.req.valid('json'));

			switch (result.kind) {
				case 'published':
					return c.json({ kind: result.kind }, 200);
				case 'missing':
					return c.json({ error: 'no such ramble' }, 404);
				case 'stale':
					return c.json({ error: 'changed elsewhere' }, 409);
				case 'not-ended':
					return c.json({ error: 'ramble has not ended' }, 409);
			}
		})
		.get('/api/ramble/:id', zValidator('param', idParam(rambleId), invalid), async (c) => {
			const view = await c.env.USER_DATA.getByName(c.var.userId).ramble(c.req.valid('param').id);

			return view ? c.json(view, 200) : c.json({ error: 'no such ramble' }, 404);
		})
		.put(
			'/api/ramble/:id',
			zValidator('param', idParam(rambleId), invalid),
			zValidator('json', rambleEdit, invalid),
			async (c) => {
				const { revision: base, body } = c.req.valid('json');

				return editReply(
					c,
					await c.env.USER_DATA.getByName(c.var.userId).editRamble({
						id: c.req.valid('param').id,
						body,
						base
					})
				);
			}
		)
		.get('/api/thought/:id', zValidator('param', idParam(thoughtId), invalid), async (c) => {
			const thought = await c.env.USER_DATA.getByName(c.var.userId).thought(
				c.req.valid('param').id
			);

			return thought ? c.json(thought, 200) : c.json({ error: 'no such thought' }, 404);
		})
		.put(
			'/api/thought/:id',
			zValidator('param', idParam(thoughtId), invalid),
			zValidator('json', thoughtEdit, invalid),
			async (c) => {
				const { revision: base, ...edit } = c.req.valid('json');

				return editReply(
					c,
					await c.env.USER_DATA.getByName(c.var.userId).editThought({
						id: c.req.valid('param').id,
						base,
						edit
					})
				);
			}
		)
		.delete(
			'/api/thought/:id',
			zValidator('param', idParam(thoughtId), invalid),
			zValidator('json', revisionOnly, invalid),
			async (c) =>
				editReply(
					c,
					await c.env.USER_DATA.getByName(c.var.userId).deleteThought({
						id: c.req.valid('param').id,
						base: c.req.valid('json').revision
					})
				)
		)
		.notFound((c) => c.json({ error: 'not found' }, 404))
		.onError((error, c) => {
			console.error(error);

			return c.json({ error: 'server error' }, 500);
		});
}

function editReply(c: Context<AppEnv>, result: EditResult) {
	switch (result) {
		case 'saved':
			return c.json({ saved: true }, 200);
		case 'missing':
			return c.json({ error: 'not found' }, 404);
		case 'conflict':
			return c.json({ error: 'changed elsewhere' }, 409);
	}
}

export type AppType = ReturnType<typeof createApp>;
