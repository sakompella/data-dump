<script lang="ts">
	import Capture from '$lib/Capture.svelte';
	import ThoughtCard from '$lib/ThoughtCard.svelte';

	let { data } = $props();

	const openTodos = $derived(data.thoughts.filter((t) => t.todo === 'open'));
	const doneTodos = $derived(data.thoughts.filter((t) => t.todo === 'done'));
</script>

<svelte:head><title>data-dump</title></svelte:head>

<Capture draft={data.draft} />

{#if data.waiting > 0}
	<p class="waiting">
		{data.waiting === 1 ? '1 ramble is' : `${data.waiting} rambles are`} waiting to be split.
	</p>
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
