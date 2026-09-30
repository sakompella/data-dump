<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import Capture from '$lib/Capture.svelte';
	import { splitRamble } from '$lib/split-client';
	import ThoughtCard from '$lib/ThoughtCard.svelte';

	let { data, form } = $props();

	// Rambles still waiting from earlier are split one at a time.
	onMount(() => {
		const waiting = data.pending;

		if (waiting.length === 0) return;

		void (async () => {
			for (const ramble of waiting) await splitRamble({ ramble, model: data.chatgptModel });
			await invalidateAll();
		})();
	});

	const openTodos = $derived(data.thoughts.filter((t) => t.todo === 'open'));

	const doneTodos = $derived(data.thoughts.filter((t) => t.todo === 'done'));
</script>

<svelte:head><title>data-dump</title></svelte:head>

<Capture draft={data.draft} model={data.chatgptModel} />

{#if data.pending.length > 0}
	<p class="waiting">
		{data.pending.length === 1 ? '1 ramble is' : `${data.pending.length} rambles are`} waiting to be
		split.
	</p>
{/if}

{#if form?.conflict}
	<p class="error">That thought changed elsewhere. Reload to see the latest.</p>
{/if}

<section>
	<h2>To-do</h2>
	{#each openTodos as thought (thought.id)}
		<ThoughtCard {thought} />
	{:else}
		<p class="empty">Nothing to do.</p>
	{/each}
</section>

<section>
	<h2>Thoughts</h2>
	{#each data.thoughts as thought (thought.id)}
		<ThoughtCard {thought} />
	{:else}
		<p class="empty">No thoughts yet.</p>
	{/each}
</section>

{#if doneTodos.length > 0}
	<details>
		<summary>Done ({doneTodos.length})</summary>
		{#each doneTodos as thought (thought.id)}
			<ThoughtCard {thought} />
		{/each}
	</details>
{/if}
