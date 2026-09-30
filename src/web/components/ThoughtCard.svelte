<script lang="ts">
	import type { ThoughtData } from '../api';

	let {
		thought,
		showRambleLink = true,
		ontoggle
	}: {
		thought: ThoughtData;
		showRambleLink?: boolean;
		ontoggle: (thought: ThoughtData, done: boolean) => void;
	} = $props();
</script>

<article class="thought">
	<header>
		{#if thought.todo !== 'none'}
			<input
				type="checkbox"
				aria-label="Done"
				checked={thought.todo === 'done'}
				onchange={(event) => ontoggle(thought, event.currentTarget.checked)}
			/>
		{/if}
		<h3>{thought.label}</h3>
	</header>
	<p class="body">{thought.body}</p>
	<nav class="links">
		<a href="/thought/{thought.id}">edit</a>
		{#if showRambleLink}<a href="/ramble/{thought.rambleId}">ramble</a>{/if}
	</nav>
</article>
