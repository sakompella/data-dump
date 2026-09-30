<script lang="ts">
	import { TODO_STATES } from '$lib/domain';

	let { data, form } = $props();

	const TODO_TEXT = { none: 'Not a to-do', open: 'To-do', done: 'Done' } as const;

	const CONFLICT_TEXT = 'Changed elsewhere. Reload to see the latest; your text is kept here.';

	const shown = $derived({ ...data.thought, ...form?.edit });
</script>

<svelte:head><title>{data.thought.label} · data-dump</title></svelte:head>

<p><a href="/">← back</a> · <a href="/ramble/{data.thought.rambleId}">source ramble</a></p>

<form method="POST" action="?/save" class="edit">
	<input type="hidden" name="revision" value={data.thought.revision} />
	<label>
		Label
		<input name="label" value={shown.label} />
	</label>
	<label>
		Text
		<textarea name="body" rows="10" value={shown.body}></textarea>
	</label>
	<fieldset>
		{#each TODO_STATES as todo (todo)}
			<label class="inline">
				<input type="radio" name="todo" value={todo} checked={shown.todo === todo} />
				{TODO_TEXT[todo]}
			</label>
		{/each}
	</fieldset>
	<button>Save</button>
	{#if form?.saved}<span class="status">saved</span>{/if}
	{#if form?.invalid}<span class="status failed">could not save</span>{/if}
	{#if form?.conflict}<span class="status failed">{CONFLICT_TEXT}</span>{/if}
</form>

<form
	method="POST"
	action="?/delete"
	onsubmit={(event) => {
		if (!confirm('Delete this thought? The ramble stays.')) event.preventDefault();
	}}
>
	<input type="hidden" name="revision" value={data.thought.revision} />
	<button class="danger">Delete thought</button>
</form>
