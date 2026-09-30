<script lang="ts">
	import { onMount } from 'svelte';
	import { TODO_STATES, type TodoState } from '../../shared/domain';
	import { api } from '../api';
	import { navigate } from '../router.svelte';

	let { id }: { id: string } = $props();

	const TODO_TEXT = { none: 'Not a to-do', open: 'To-do', done: 'Done' } as const;

	const CONFLICT_TEXT = 'Changed elsewhere. Reload to see the latest; your text is kept here.';

	type SaveState = 'idle' | 'saved' | 'invalid' | 'conflict';

	type ThoughtView = Extract<Awaited<ReturnType<typeof load>>, { kind: 'loaded' }>['thought'];

	async function load() {
		try {
			const res = await api.thought[':id'].$get({ param: { id } });

			if (res.ok) return { kind: 'loaded', thought: await res.json() } as const;

			return { kind: res.status === 404 ? 'missing' : 'failed' } as const;
		} catch {
			return { kind: 'failed' } as const;
		}
	}

	let loading = $state<'loading' | 'missing' | 'failed' | 'loaded'>('loading');

	let thought = $state<ThoughtView | null>(null);

	let label = $state('');

	let body = $state('');

	let todo = $state<TodoState>('none');

	let saveState = $state<SaveState>('idle');

	async function refresh(): Promise<void> {
		const result = await load();

		loading = result.kind;

		if (result.kind === 'loaded') {
			thought = result.thought;
			({ label, body, todo } = result.thought);
		}
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();

		if (!thought) return;

		try {
			const res = await api.thought[':id'].$put({
				param: { id },
				json: { revision: thought.revision, label, body, todo }
			});

			saveState = res.ok ? 'saved' : res.status === 409 ? 'conflict' : 'invalid';

			// Only the revision moves on; what is in the form stays as typed.
			const fresh = res.ok ? await load() : null;

			if (fresh?.kind === 'loaded') thought = fresh.thought;
		} catch {
			saveState = 'invalid';
		}
	}

	async function remove(event: SubmitEvent) {
		event.preventDefault();

		if (!thought || !confirm('Delete this thought? The ramble stays.')) return;

		try {
			const res = await api.thought[':id'].$delete({
				param: { id },
				json: { revision: thought.revision }
			});

			if (res.ok || res.status === 404) navigate('/');
			else saveState = res.status === 409 ? 'conflict' : 'invalid';
		} catch {
			saveState = 'invalid';
		}
	}

	onMount(() => void refresh());
</script>

<svelte:head><title>{thought?.label ?? 'Thought'} · data-dump</title></svelte:head>

{#if loading === 'missing'}
	<p><a href="/">← back</a></p>
	<p class="empty">No such thought.</p>
{:else if loading === 'failed'}
	<p><a href="/">← back</a></p>
	<p class="error">Could not load.</p>
{:else if thought}
	<p><a href="/">← back</a> · <a href="/ramble/{thought.rambleId}">source ramble</a></p>

	<form onsubmit={save} class="edit">
		<label>
			Label
			<input bind:value={label} />
		</label>
		<label>
			Text
			<textarea bind:value={body} rows="10"></textarea>
		</label>
		<fieldset>
			{#each TODO_STATES as state (state)}
				<label class="inline">
					<input type="radio" name="todo" value={state} bind:group={todo} />
					{TODO_TEXT[state]}
				</label>
			{/each}
		</fieldset>
		<button>Save</button>
		{#if saveState === 'saved'}<span class="status">saved</span>{/if}
		{#if saveState === 'invalid'}<span class="status failed">could not save</span>{/if}
		{#if saveState === 'conflict'}<span class="status failed">{CONFLICT_TEXT}</span>{/if}
	</form>

	<form onsubmit={remove}>
		<button class="danger">Delete thought</button>
	</form>
{/if}
