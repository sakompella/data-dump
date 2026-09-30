import { DurableObject } from 'cloudflare:workers';
import type { RambleId, ThoughtId } from '../shared/domain';
import type { Revision } from '../shared/ids';
import type { ProposedThought } from '../shared/proposals';
import {
	createUserRules,
	migrate,
	type EditResult,
	type FinishResult,
	type HomeView,
	type PendingSplit,
	type RambleView,
	type SaveResult,
	type Sql,
	type Stored,
	type ThoughtEdit
} from './rules';
import type { Thought } from '../shared/domain';
import { sqlRows } from './sql-rows';

const durableSql = (storage: DurableObjectStorage): Sql => ({
	query: (statement, ...bindings) =>
		sqlRows.parse(storage.sql.exec(statement, ...bindings).toArray()),
	transaction: (work) => storage.transactionSync(work)
});

// One user's data. The Worker reaches it through env.USER_DATA.idFromName(userId),
// so each user has a separate SQLite database. The rules live in ./rules.
export class UserData extends DurableObject<Env> {
	readonly #rules: ReturnType<typeof createUserRules>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const sql = durableSql(ctx.storage);
		void ctx.blockConcurrencyWhile(async () => migrate(sql, new Date()));
		this.#rules = createUserRules({ sql, now: () => new Date() });
	}

	home(): HomeView {
		this.#rules.settleOnLoad();

		return this.#rules.home();
	}

	saveDraft(save: { id: RambleId; body: string; base: Revision | null }): SaveResult {
		return this.#rules.saveDraft(save);
	}

	endRamble(id: RambleId): PendingSplit | null {
		return this.#rules.endRamble(id);
	}

	finishSplit(split: {
		id: RambleId;
		revision: Revision;
		proposals: readonly ProposedThought[];
	}): FinishResult {
		return this.#rules.finishSplit(split);
	}

	ramble(id: RambleId): RambleView | null {
		return this.#rules.ramble(id);
	}

	thought(id: ThoughtId): Stored<Thought> | null {
		return this.#rules.thought(id);
	}

	editRamble(edit: { id: RambleId; body: string; base: Revision }): EditResult {
		return this.#rules.editRamble(edit);
	}

	editThought(edit: { id: ThoughtId; base: Revision; edit: Partial<ThoughtEdit> }): EditResult {
		return this.#rules.editThought(edit);
	}

	deleteThought(deletion: { id: ThoughtId; base: Revision }): EditResult {
		return this.#rules.deleteThought(deletion);
	}
}
