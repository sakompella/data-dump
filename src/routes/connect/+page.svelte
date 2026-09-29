<script lang="ts">
	let { data, form } = $props();

	const STATUS_TEXT = {
		connected: 'ChatGPT is connected. Rambles are split through it.',
		'not-connected': 'ChatGPT is not connected.',
		'needs-reconnect': 'ChatGPT needs to be reconnected. Rambles wait until it is.'
	} as const;
</script>

<svelte:head><title>ChatGPT · data-dump</title></svelte:head>

<p><a href="/">← back</a></p>

<p class:failed={data.status === 'needs-reconnect'}>{STATUS_TEXT[data.status]}</p>
{#if data.modelMissing}
	<p class="error">CHATGPT_MODEL is not set. Splitting through ChatGPT fails until it is.</p>
{/if}

{#if data.signInUrl}
	<form method="POST" action="?/complete" class="edit">
		<p>
			1. <a href={data.signInUrl} target="_blank" rel="noopener noreferrer">Sign in with ChatGPT</a>
			(opens in a new tab).
		</p>
		<label>
			2. After signing in, the browser lands on a page that does not load. Copy that page's full
			address and paste it here.
			<input name="address" placeholder={data.redirectUri} autocomplete="off" required />
		</label>
		<button>Connect</button>
		{#if form?.error}<p class="error">{form.error}</p>{/if}
	</form>
	<form method="POST" action="?/start">
		<button>Start again</button>
	</form>
{:else}
	<form method="POST" action="?/start">
		<button>{data.status === 'not-connected' ? 'Connect' : 'Connect again'}</button>
	</form>
{/if}

{#if data.status !== 'not-connected'}
	<form method="POST" action="?/disconnect">
		<button class="danger">Disconnect</button>
	</form>
{/if}
