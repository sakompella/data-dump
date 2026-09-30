import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newRambleId, newThoughtId } from '../shared/ids';
import { createNodeSql } from './testing/node-sql';
import { createUserRules, migrate, type Sql } from './rules';

// The schema of each superseded version, as it shipped. Empty while only
// version 1 exists; a new migration must add its predecessor here, so its
// upgrade path is tested.
const EARLIER_SCHEMAS: ReadonlyMap<number, readonly string[]> = new Map();

const NOW = new Date('2026-01-01T00:00:00Z');

let sql: ReturnType<typeof createNodeSql>;

beforeEach(() => {
	sql = createNodeSql();
});

afterEach(() => sql.close());

const schemaOf = (db: Sql) =>
	db.query(
		"SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
	);

const versionsOf = (db: Sql) =>
	db.query('SELECT version FROM migrations ORDER BY version').map((row) => row.version);

function freshSchema() {
	const fresh = createNodeSql();
	migrate(fresh, NOW);
	const schema = { tables: schemaOf(fresh), versions: versionsOf(fresh) };
	fresh.close();

	return schema;
}

function atVersion(db: Sql, version: number) {
	db.query('CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');

	for (let v = 1; v <= version; v += 1) {
		for (const statement of EARLIER_SCHEMAS.get(v) ?? []) db.query(statement);
		db.query('INSERT INTO migrations (version, applied_at) VALUES (?, ?)', v, NOW.getTime());
	}
}

describe('migrate', () => {
	it('brings a new database to a schema the rules can use, with every version recorded', () => {
		migrate(sql, NOW);
		const { versions } = freshSchema();
		expect(versionsOf(sql)).toEqual(versions.map((_, index) => index + 1));
		expect(schemaOf(sql).map((row) => row.name)).toEqual(
			expect.arrayContaining(['rambles', 'thoughts', 'discarded_rambles', 'migrations'])
		);

		const data = createUserRules({ sql, now: () => NOW });
		const id = newRambleId();
		data.saveDraft({ id, body: 'kept', base: null });
		expect(data.ramble(id)?.ramble.body).toBe('kept');
	});

	it('keeps rows and the schema when run again', () => {
		migrate(sql, NOW);
		const data = createUserRules({ sql, now: () => NOW });
		const id = newRambleId();
		data.saveDraft({ id, body: 'kept', base: null });
		const before = schemaOf(sql);

		migrate(sql, NOW);
		expect(schemaOf(sql)).toEqual(before);
		expect(data.ramble(id)?.ramble.body).toBe('kept');
	});

	it('has a stored schema for every earlier version', () => {
		const latest = freshSchema().versions.length;
		const earlier = Array.from({ length: latest - 1 }, (_, index) => index + 1);
		expect([...EARLIER_SCHEMAS.keys()].filter((v) => v < latest)).toEqual(earlier);
	});

	it('upgrades a database from every earlier version to the fresh schema and keeps its rows', () => {
		const fresh = freshSchema();

		for (const version of [...EARLIER_SCHEMAS.keys()].filter((v) => v < fresh.versions.length)) {
			const db = createNodeSql();
			atVersion(db, version);
			const rambleId = newRambleId();
			const thoughtId = newThoughtId();
			db.query(
				"INSERT INTO rambles (id, status, revision, created_at, updated_at, body) VALUES (?, 'split', 2, 0, 0, 'old ramble')",
				rambleId
			);
			db.query(
				"INSERT INTO thoughts (id, ramble_id, label, todo, revision, created_at, body) VALUES (?, ?, 'old', 'open', 1, 0, 'old thought')",
				thoughtId,
				rambleId
			);

			migrate(db, NOW);
			expect(schemaOf(db), `from version ${version}`).toEqual(fresh.tables);
			expect(versionsOf(db)).toEqual(fresh.versions);
			const data = createUserRules({ sql: db, now: () => NOW });
			expect(data.ramble(rambleId)?.ramble.body).toBe('old ramble');
			expect(data.thought(thoughtId)?.body).toBe('old thought');
			db.close();
		}
	});
});
