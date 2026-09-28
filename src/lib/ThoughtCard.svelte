<script lang="ts">
	import { enhance } from '$app/forms';
	import type { Thought } from '$lib/domain';

	let { thought, showRambleLink = true }: { thought: Thought; showRambleLink?: boolean } = $props();
</script>

<article class="thought">
	<header>
		{#if thought.todo !== 'none'}
			<form method="POST" action="/?/toggle" use:enhance>
				<input type="hidden" name="id" value={thought.id} />
				<input
					type="checkbox"
					name="done"
					aria-label="Done"
					checked={thought.todo === 'done'}
					onchange={(event) => event.currentTarget.form?.requestSubmit()}
				/>
			</form>
		{/if}
		<h3>{thought.label}</h3>
	</header>
	<p class="body">{thought.body}</p>
	<nav class="links">
		<a href="/thought/{thought.id}">edit</a>
		{#if showRambleLink}<a href="/ramble/{thought.rambleId}">ramble</a>{/if}
	</nav>
</article>
