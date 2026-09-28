<script lang="ts">
	import ThoughtCard from '$lib/ThoughtCard.svelte';

	let { data, form } = $props();

	const STATUS_TEXT = {
		open: 'still open',
		ended: 'waiting to be split',
		split: 'split into thoughts'
	} as const;
</script>

<svelte:head><title>Ramble · data-dump</title></svelte:head>

<p><a href="/">← back</a></p>

<p class="meta">
	Started {data.ramble.createdAt.toLocaleString()} · {STATUS_TEXT[data.ramble.status]}
</p>

<form method="POST" action="?/save" class="edit">
	<textarea name="body" rows="16" aria-label="Ramble text" value={data.ramble.body}></textarea>
	<button>Save</button>
	{#if form?.saved}<span class="status">saved. Thoughts copied from it are unchanged.</span>{/if}
	{#if form?.invalid}<span class="status failed">could not save</span>{/if}
</form>

{#if data.thoughts.length > 0}
	<section>
		<h2>Thoughts from this ramble</h2>
		{#each data.thoughts as thought (thought.id)}
			<ThoughtCard {thought} showRambleLink={false} />
		{/each}
	</section>
{/if}
