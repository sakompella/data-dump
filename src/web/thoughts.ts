import { api, type ThoughtData } from './api';

export type ToggleResult = 'saved' | 'conflict' | 'failed';

export async function setDone(thought: ThoughtData, done: boolean): Promise<ToggleResult> {
	try {
		const res = await api.thought[':id'].$put({
			param: { id: thought.id },
			json: { revision: thought.revision, todo: done ? 'done' : 'open' }
		});

		if (res.ok) return 'saved';

		return res.status === 409 ? 'conflict' : 'failed';
	} catch {
		return 'failed';
	}
}
