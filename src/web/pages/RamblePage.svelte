<script lang="ts">
	import { onMount } from 'svelte';
	import { z } from 'zod';
	import { api, type ThoughtData } from '../api';
	import EditorRecovery from '../components/EditorRecovery.svelte';
	import ThoughtCard from '../components/ThoughtCard.svelte';
	import { editorBackups } from '../tab';
	import { setDone } from '../thoughts';

	let { id }: { id: string } = $props();

	const STATUS_TEXT = {
		open: 'still open',
		ended: 'waiting to be split',
		split: 'split into thoughts'
	} as const;

	type RambleData = Extract<Awaited<ReturnType<typeof load>>, { kind: 'loaded' }>['view'];

	async function load() {
		try {
			const res = await api.ramble[':id'].$get({ param: { id } });

			if (res.ok) return { kind: 'loaded', view: await res.json() } as const;

			return { kind: res.status === 404 ? 'missing' : 'failed' } as const;
		} catch {
			return { kind: 'failed' } as const;
		}
	}

	type Others = Awaited<ReturnType<typeof backups.others>>;

	type SaveState = 'idle' | 'saved' | 'invalid' | 'conflict';

	const doc = $derived(`ramble:${id}`);

	const backups = editorBackups(z.object({ body: z.string() }), () => (backupFailed = true));

	let backupFailed = $state(false);

	let loading = $state<'loading' | 'missing' | 'failed' | 'loaded'>('loading');

	let view = $state<RambleData | null>(null);

	let body = $state('');

	// The revision the text in the box is based on, and the server's text at
	// that point. While they differ from the box, a backup is kept.
	let base = $state(0);

	let saved = $state({ body: '' });

	// The server's current version, when the box holds something else.
	let latest = $state<{ body: string; revision: number } | null>(null);

	let restored = $state(false);

	let others = $state<Others>([]);

	let ready = $state(false);

	let saveState = $state<SaveState>('idle');

	let toggleConflict = $state(false);

	$effect(() => {
		if (ready) backups.sync(doc, { body }, saved, base);
	});

	async function refresh(): Promise<void> {
		const result = await load();

		loading = result.kind;

		if (result.kind !== 'loaded') return;
		view = result.view;
		const server = { body: result.view.ramble.body };
		const found = await backups.restore(doc, server);

		latest = { ...server, revision: result.view.ramble.revision };
		saved = server;

		if (found) {
			({ body } = found.draft);
			base = found.revision;
			restored = true;
		} else {
			({ body } = server);
			base = result.view.ramble.revision;
		}

		others = await backups.others(doc, saved, { body });
		ready = true;
	}

	const refreshOthers = async () => (others = await backups.others(doc, saved, { body }));

	async function useOther(index: number) {
		const other = others[index];

		if (!other || !backups.swapIn(doc, other, { draft: { body }, revision: base }, saved)) return;
		({ body } = other.draft);
		base = other.revision;
		restored = true;
		await refreshOthers();
	}

	async function dropOther(index: number) {
		const other = others[index];

		if (other) backups.discard(other);
		await refreshOthers();
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();

		if (!view) return;
		const sent = { body };

		try {
			const res = await api.ramble[':id'].$put({ param: { id }, json: { body, revision: base } });

			saveState = res.ok ? 'saved' : res.status === 409 ? 'conflict' : 'invalid';

			if (res.ok) {
				({ revision: base } = await res.json());
				saved = sent;
				restored = false;
			} else if (res.status === 409) {
				const fresh = await load();

				if (fresh.kind === 'loaded') {
					latest = { body: fresh.view.ramble.body, revision: fresh.view.ramble.revision };
				}
			}
		} catch {
			saveState = 'invalid';
		}
	}

	// Explicit choice after looking at the current version: the text stays, only its base moves.
	function rebase() {
		if (!latest) return;
		base = latest.revision;
		saved = { body: latest.body };
		saveState = 'idle';
	}

	function discard() {
		if (!latest) return;
		body = latest.body;
		base = latest.revision;
		saved = { body: latest.body };
		restored = false;
		saveState = 'idle';
		backups.remove(doc);
	}

	async function toggle(thought: ThoughtData, done: boolean) {
		toggleConflict = (await setDone(thought, done)) === 'conflict';
		const fresh = await load();

		if (fresh.kind === 'loaded' && view) view = { ...view, thoughts: fresh.view.thoughts };
	}

	onMount(() => void refresh());
</script>

<svelte:head><title>Ramble · data-dump</title></svelte:head>

<p><a href="/">← back</a></p>

{#if loading === 'missing'}
	<p class="empty">No such ramble.</p>
{:else if loading === 'failed'}
	<p class="error">Could not load.</p>
{:else if view && !ready}
	<p class="empty">Loading…</p>
{:else if view}
	<p class="meta">
		Started {new Date(view.ramble.createdAt).toLocaleString()} · {STATUS_TEXT[view.ramble.status]}
	</p>

	<form onsubmit={save} class="edit">
		<textarea bind:value={body} rows="16" aria-label="Ramble text"></textarea>
		<button>Save</button>
		{#if saveState === 'saved'}<span class="status">saved. Thoughts copied from it are unchanged.</span>{/if}
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

	{#if toggleConflict}
		<p class="error">That thought changed elsewhere. Reload to see the latest.</p>
	{/if}

	{#if view.thoughts.length > 0}
		<section>
			<h2>Thoughts from this ramble</h2>
			{#each view.thoughts as thought (thought.id)}
				<ThoughtCard {thought} showRambleLink={false} ontoggle={toggle} />
			{/each}
		</section>
	{/if}
{/if}
