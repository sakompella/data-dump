<script lang="ts">
	let { form } = $props();
</script>

<svelte:head><title>Log in · data-dump</title></svelte:head>

<form method="POST" class="login">
	<label>
		Password
		<!-- svelte-ignore a11y_autofocus -->
		<input type="password" name="password" autocomplete="current-password" autofocus required />
	</label>
	<button>Log in</button>
	{#if form?.wrong}<p class="error">Wrong password.</p>{/if}
</form>
