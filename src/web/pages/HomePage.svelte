<script lang="ts">
	import { onMount } from 'svelte';
	import { api, chatgptModel, type HomeData, type ThoughtData } from '../api';
	import Capture from '../components/Capture.svelte';
	import ThoughtCard from '../components/ThoughtCard.svelte';
	import { savesSettled } from '../pending-saves';
	import { splitRamble } from '../split-client';
	import { setDone } from '../thoughts';

	let home = $state<HomeData | null>(null);

	let model = $state<string | null>(null);

	let failed = $state(false);

	let conflict = $state(false);

	// Keeps the page as it is when a reload fails.
	async function load() {
		try {
			const res = await api.home.$get();

			if (res.ok) {
				home = await res.json();
				failed = false;
			} else {
				failed = true;
			}
		} catch {
			failed = true;
		}
	}

	async function toggle(thought: ThoughtData, done: boolean) {
		const result = await setDone(thought, done);

		conflict = result === 'conflict';
		await load();
	}

	// Rambles still waiting from earlier are split one at a time.
	onMount(() => {
		void (async () => {
			await savesSettled();
			[model] = await Promise.all([chatgptModel(), load()]);
			const waiting = home?.pending ?? [];

			if (waiting.length === 0) return;

			for (const ramble of waiting) await splitRamble({ ramble, model });
			await load();
		})();
	});

	const openTodos = $derived(home?.thoughts.filter((t) => t.todo === 'open') ?? []);

	const doneTodos = $derived(home?.thoughts.filter((t) => t.todo === 'done') ?? []);
</script>

<svelte:head><title>data-dump</title></svelte:head>

{#if home}
	<Capture draft={home.draft} {model} onchange={load} />

	{#if home.pending.length > 0}
		<p class="waiting">
			{home.pending.length === 1 ? '1 ramble is' : `${home.pending.length} rambles are`} waiting to
			be split.
		</p>
	{/if}

	{#if conflict}
		<p class="error">That thought changed elsewhere. Reload to see the latest.</p>
	{/if}

	<section>
		<h2>To-do</h2>
		{#each openTodos as thought (thought.id)}
			<ThoughtCard {thought} ontoggle={toggle} />
		{:else}
			<p class="empty">Nothing to do.</p>
		{/each}
	</section>

	<section>
		<h2>Thoughts</h2>
		{#each home.thoughts as thought (thought.id)}
			<ThoughtCard {thought} ontoggle={toggle} />
		{:else}
			<p class="empty">No thoughts yet.</p>
		{/each}
	</section>

	{#if doneTodos.length > 0}
		<details>
			<summary>Done ({doneTodos.length})</summary>
			{#each doneTodos as thought (thought.id)}
				<ThoughtCard {thought} ontoggle={toggle} />
			{/each}
		</details>
	{/if}
{:else if failed}
	<p class="error">Could not load. <button type="button" onclick={load}>Retry</button></p>
{/if}
