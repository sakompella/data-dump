import { DatabaseSync } from 'node:sqlite';
import { sqlRows } from '../sql-rows';
import type { Sql } from '../rules';

// The Durable Object's SQL, played by Node's built-in SQLite.
export function createNodeSql(): Sql & { close(): void } {
	const db = new DatabaseSync(':memory:');

	return {
		query: (statement, ...bindings) => sqlRows.parse(db.prepare(statement).all(...bindings)),
		transaction(work) {
			db.exec('BEGIN');

			try {
				const result = work();
				db.exec('COMMIT');

				return result;
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},
		close: () => db.close()
	};
}
