<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type ThoughtData } from '../api';
	import ThoughtCard from '../components/ThoughtCard.svelte';
	import { setDone } from '../thoughts';

	let { id }: { id: string } = $props();

	const STATUS_TEXT = {
		open: 'still open',
		ended: 'waiting to be split',
		split: 'split into thoughts'
	} as const;

	const CONFLICT_TEXT = 'Changed elsewhere. Reload to see the latest; your text is kept here.';

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

	type SaveState = 'idle' | 'saved' | 'invalid' | 'conflict';

	let loading = $state<'loading' | 'missing' | 'failed' | 'loaded'>('loading');

	let view = $state<RambleData | null>(null);

	let body = $state('');

	let saveState = $state<SaveState>('idle');

	let toggleConflict = $state(false);

	async function refresh(): Promise<void> {
		const result = await load();

		loading = result.kind;

		if (result.kind === 'loaded') {
			view = result.view;
			body = result.view.ramble.body;
		}
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();

		if (!view) return;

		try {
			const res = await api.ramble[':id'].$put({
				param: { id },
				json: { body, revision: view.ramble.revision }
			});

			saveState = res.ok ? 'saved' : res.status === 409 ? 'conflict' : 'invalid';

			// The revision moved on; the text in the box stays as typed.
			if (res.ok) {
				const { revision } = await res.json();
				view = { ...view, ramble: { ...view.ramble, revision } };
			}
		} catch {
			saveState = 'invalid';
		}
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
{:else if view}
	<p class="meta">
		Started {new Date(view.ramble.createdAt).toLocaleString()} · {STATUS_TEXT[view.ramble.status]}
	</p>

	<form onsubmit={save} class="edit">
		<textarea bind:value={body} rows="16" aria-label="Ramble text"></textarea>
		<button>Save</button>
		{#if saveState === 'saved'}<span class="status">saved. Thoughts copied from it are unchanged.</span>{/if}
		{#if saveState === 'invalid'}<span class="status failed">could not save</span>{/if}
		{#if saveState === 'conflict'}<span class="status failed">{CONFLICT_TEXT}</span>{/if}
	</form>

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
