<script lang="ts">
	import { onMount } from 'svelte';
	import { TODO_STATES, type TodoState } from '../../shared/domain';
	import { z } from 'zod';
	import { api } from '../api';
	import EditorRecovery from '../components/EditorRecovery.svelte';
	import { navigate } from '../router.svelte';
	import { editorBackups } from '../tab';

	let { id }: { id: string } = $props();

	const TODO_TEXT = { none: 'Not a to-do', open: 'To-do', done: 'Done' } as const;

	type Others = Awaited<ReturnType<typeof backups.others>>;

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

	const draftSchema = z.object({ label: z.string(), body: z.string(), todo: z.enum(TODO_STATES) });

	const doc = $derived(`thought:${id}`);

	const backups = editorBackups(draftSchema, () => (backupFailed = true));

	let backupFailed = $state(false);

	let loading = $state<'loading' | 'missing' | 'failed' | 'loaded'>('loading');

	let thought = $state<ThoughtView | null>(null);

	let label = $state('');

	let body = $state('');

	let todo = $state<TodoState>('none');

	// The revision the form is based on, and the server's text at that point.
	// While they differ from the form, a backup is kept.
	let base = $state(0);

	let saved = $state<{ label: string; body: string; todo: TodoState }>({
		label: '',
		body: '',
		todo: 'none'
	});

	// The server's current version, when the form holds something else.
	let latest = $state<{ label: string; body: string; todo: TodoState; revision: number } | null>(
		null
	);

	let restored = $state(false);

	let others = $state<Others>([]);

	let ready = $state(false);

	let saveState = $state<SaveState>('idle');

	$effect(() => {
		if (ready) backups.sync(doc, { label, body, todo }, saved, base);
	});

	const draftOf = (t: { label: string; body: string; todo: TodoState }) => ({
		label: t.label,
		body: t.body,
		todo: t.todo
	});

	async function refresh(): Promise<void> {
		const result = await load();

		loading = result.kind;

		if (result.kind !== 'loaded') return;
		thought = result.thought;
		const server = draftOf(result.thought);
		const found = await backups.restore(doc, server);

		latest = { ...server, revision: result.thought.revision };
		saved = server;

		if (found) {
			({ label, body, todo } = found.draft);
			base = found.revision;
			restored = true;
		} else {
			({ label, body, todo } = server);
			base = result.thought.revision;
		}

		others = await backups.others(doc, saved, { label, body, todo });
		ready = true;
	}

	const refreshOthers = async () =>
		(others = await backups.others(doc, saved, { label, body, todo }));

	async function useOther(index: number) {
		const other = others[index];

		if (!other) return;

		const current = { draft: { label, body, todo }, revision: base };

		if (!backups.swapIn(doc, other, current, saved)) return;
		({ label, body, todo } = other.draft);
		base = other.revision;
		restored = true;
		await refreshOthers();
	}

	async function dropOther(index: number) {
		const other = others[index];

		if (other) backups.discard(other);
		await refreshOthers();
	}

	async function noteConflict() {
		saveState = 'conflict';
		const fresh = await load();

		if (fresh.kind === 'loaded') {
			latest = { ...draftOf(fresh.thought), revision: fresh.thought.revision };
		}
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();

		if (!thought) return;
		const sent = { label, body, todo };

		try {
			const res = await api.thought[':id'].$put({
				param: { id },
				json: { revision: base, ...sent }
			});

			if (res.ok) {
				({ revision: base } = await res.json());
				saved = sent;
				restored = false;
				saveState = 'saved';
			} else if (res.status === 409) {
				await noteConflict();
			} else {
				saveState = 'invalid';
			}
		} catch {
			saveState = 'invalid';
		}
	}

	async function remove(event: SubmitEvent) {
		event.preventDefault();

		if (!thought || !confirm('Delete this thought? The ramble stays.')) return;

		try {
			const res = await api.thought[':id'].$delete({ param: { id }, json: { revision: base } });

			if (res.ok || res.status === 404) {
				backups.remove(doc);
				navigate('/');
			} else if (res.status === 409) {
				await noteConflict();
			} else {
				saveState = 'invalid';
			}
		} catch {
			saveState = 'invalid';
		}
	}

	// Explicit choice after looking at the current version: the text stays, only its base moves.
	function rebase() {
		if (!latest) return;
		base = latest.revision;
		saved = draftOf(latest);
		saveState = 'idle';
	}

	function discard() {
		if (!latest) return;
		({ label, body, todo } = latest);
		base = latest.revision;
		saved = draftOf(latest);
		restored = false;
		saveState = 'idle';
		backups.remove(doc);
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
{:else if thought && !ready}
	<p><a href="/">← back</a></p>
	<p class="empty">Loading…</p>
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
	</form>

	<EditorRecovery
		{restored}
		conflict={saveState === 'conflict'}
		{backupFailed}
		{latest}
		others={others.map((other) => other.draft)}
		onuse={useOther}
		ondrop={dropOther}
		ondiscard={discard}
		onrebase={rebase}
	/>

	<form onsubmit={remove}>
		<button class="danger">Delete thought</button>
	</form>
{/if}
