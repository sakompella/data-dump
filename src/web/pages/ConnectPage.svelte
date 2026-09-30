<script lang="ts">
	import { onMount } from 'svelte';
	import { chatgptModel } from '../api';
	import type { ConnectionStatus } from '../chatgpt/auth';
	import { chatgptAuth } from '../split-client';

	const STATUS_TEXT = {
		connected: 'ChatGPT is connected. Rambles are split through it, from this browser.',
		'not-connected': 'ChatGPT is not connected.',
		'needs-reconnect': 'ChatGPT needs to be reconnected. Rambles wait until it is.'
	} as const;

	const auth = chatgptAuth();

	let status = $state<ConnectionStatus>(auth.status());

	let signInUrl = $state<string | null>(null);

	let address = $state('');

	let error = $state<string | null>(null);

	let busy = $state(false);

	// Undefined until the Worker has answered.
	let model = $state<string | null | undefined>();

	async function reload() {
		status = auth.status();
		signInUrl = (await auth.pendingLogin())?.toString() ?? null;
	}

	async function start() {
		error = null;
		await auth.startLogin();
		await reload();
	}

	async function complete(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		const result = await auth.completeLogin(address);
		busy = false;
		error = result.ok ? null : result.error;

		if (result.ok) address = '';
		await reload();
	}

	async function disconnect() {
		await auth.disconnect();
		await reload();
	}

	onMount(() => {
		void reload();
		void chatgptModel().then((name) => (model = name));
	});
</script>

<svelte:head><title>ChatGPT · data-dump</title></svelte:head>

<p><a href="/">← back</a></p>

<p class:failed={status === 'needs-reconnect'}>{STATUS_TEXT[status]}</p>
{#if model === null}
	<p class="error">
		CHATGPT_MODEL is not set. Rambles wait instead of being split until it is.
	</p>
{/if}
<p class="meta">Your ChatGPT sign-in is kept in this browser only; the site never sees it.</p>

{#if signInUrl}
	<form onsubmit={complete} class="edit">
		<p>
			1. <a href={signInUrl} target="_blank" rel="noopener noreferrer">Sign in with ChatGPT</a>
			(opens in a new tab).
		</p>
		<label>
			2. After signing in, the browser lands on a page that does not load. Copy that page's full
			address and paste it here.
			<input bind:value={address} placeholder={auth.redirectUri} autocomplete="off" required />
		</label>
		<button disabled={busy}>Connect</button>
		{#if error}<p class="error">{error}</p>{/if}
	</form>
	<p><button type="button" onclick={start}>Start again</button></p>
{:else}
	<p>
		<button type="button" onclick={start}>
			{status === 'not-connected' ? 'Connect' : 'Connect again'}
		</button>
	</p>
{/if}

{#if status !== 'not-connected'}
	<p><button type="button" class="danger" onclick={disconnect}>Disconnect</button></p>
{/if}
