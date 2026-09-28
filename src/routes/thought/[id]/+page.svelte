<script lang="ts">
	import { TODO_STATES } from '$lib/domain';

	let { data, form } = $props();

	const TODO_TEXT = { none: 'Not a to-do', open: 'To-do', done: 'Done' } as const;
</script>

<svelte:head><title>{data.thought.label} · data-dump</title></svelte:head>

<p><a href="/">← back</a> · <a href="/ramble/{data.thought.rambleId}">source ramble</a></p>

<form method="POST" action="?/save" class="edit">
	<label>
		Label
		<input name="label" value={data.thought.label} />
	</label>
	<label>
		Text
		<textarea name="body" rows="10" value={data.thought.body}></textarea>
	</label>
	<fieldset>
		{#each TODO_STATES as todo (todo)}
			<label class="inline">
				<input type="radio" name="todo" value={todo} checked={data.thought.todo === todo} />
				{TODO_TEXT[todo]}
			</label>
		{/each}
	</fieldset>
	<button>Save</button>
	{#if form?.saved}<span class="status">saved</span>{/if}
	{#if form?.invalid}<span class="status failed">could not save</span>{/if}
</form>

<form
	method="POST"
	action="?/delete"
	onsubmit={(event) => {
		if (!confirm('Delete this thought? The ramble stays.')) event.preventDefault();
	}}
>
	<button class="danger">Delete thought</button>
</form>
