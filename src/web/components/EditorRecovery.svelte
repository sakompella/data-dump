<script lang="ts">
	interface Version {
		readonly label?: string;
		readonly body: string;
	}

	let {
		restored,
		conflict,
		backupFailed,
		latest,
		others,
		ondiscard,
		onrebase,
		onuse,
		ondrop
	}: {
		restored: boolean;
		conflict: boolean;
		backupFailed: boolean;
		// The server's current version, shown read-only so it can be compared.
		latest: Version | null;
		// Other unsaved drafts of this document found in this browser.
		others: readonly Version[];
		ondiscard: () => void;
		onrebase: () => void;
		onuse: (index: number) => void;
		ondrop: (index: number) => void;
	} = $props();
</script>

{#if restored}
	<p class="status">
		Restored your unsaved edits from this browser.
		<button type="button" class="small" onclick={ondiscard}>Discard restored edits</button>
	</p>
{/if}
{#if conflict}
	<p class="status failed">
		Changed elsewhere. Your text is kept here and backed up in this browser. Compare it with the
		current version below.
		<button type="button" class="small" onclick={onrebase}>Keep my text on the latest version</button>
	</p>
{/if}
{#if backupFailed}
	<p class="status failed">Backup unavailable in this browser. Do not close this page before saving.</p>
{/if}
{#if latest && (restored || conflict)}
	<details open>
		<summary>Current saved version (read-only)</summary>
		{#if latest.label !== undefined}<p class="meta">Label: {latest.label}</p>{/if}
		<textarea readonly rows="8" aria-label="Current saved version">{latest.body}</textarea>
	</details>
{/if}
{#each others as other, index (index)}
	<details open>
		<summary>Another unsaved draft found in this browser</summary>
		{#if other.label !== undefined}<p class="meta">Label: {other.label}</p>{/if}
		<textarea readonly rows="6" aria-label="Another unsaved draft">{other.body}</textarea>
		<button type="button" class="small" onclick={() => onuse(index)}>
			Use this text (keeps what is in the editor as another draft)
		</button>
		<button type="button" class="small danger" onclick={() => ondrop(index)}>Discard this draft</button>
	</details>
{/each}
