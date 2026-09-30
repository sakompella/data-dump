import type { UserDataNamespace } from '../env';
import { createUserRules, migrate } from '../rules';
import { createNodeSql } from './node-sql';

// Stands in for env.USER_DATA: one in-memory database per name, running the
// same rules as the Durable Object.
export function createFakeNamespace(): UserDataNamespace & { close(): void } {
	const databases = new Map<string, ReturnType<typeof createNodeSql>>();

	return {
		getByName(name) {
			const existing = databases.get(name) ?? createNodeSql();

			if (!databases.has(name)) {
				migrate(existing, new Date());
				databases.set(name, existing);
			}

			const rules = createUserRules({ sql: existing, now: () => new Date() });

			return {
				home: async () => {
					rules.settleOnLoad();

					return rules.home();
				},
				saveDraft: async (save) => rules.saveDraft(save),
				endRamble: async (id) => rules.endRamble(id),
				finishSplit: async (split) => rules.finishSplit(split),
				ramble: async (id) => rules.ramble(id),
				thought: async (id) => rules.thought(id),
				editRamble: async (edit) => rules.editRamble(edit),
				editThought: async (edit) => rules.editThought(edit),
				deleteThought: async (deletion) => rules.deleteThought(deletion)
			};
		},
		close: () => databases.forEach((database) => database.close())
	};
}
