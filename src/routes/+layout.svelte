<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import favicon from '$lib/assets/favicon.svg';
	import type { ConnectionStatus } from '$lib/chatgpt/auth';
	import { chatgptAuth } from '$lib/split-client';

	let { children } = $props();

	// Tokens live in this browser, so the header learns the status here.
	let chatgpt = $state<ConnectionStatus | null>(null);

	const refresh = () => (chatgpt = chatgptAuth().status());

	afterNavigate(refresh);

	onMount(() => {
		window.addEventListener('storage', refresh);

		return () => window.removeEventListener('storage', refresh);
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<main>
	<header class="site">
		<h1><a href="/">data-dump</a></h1>
		{#if chatgpt === 'needs-reconnect'}
			<a class="failed" href="/connect">reconnect ChatGPT</a>
		{:else if chatgpt}
			<a class="meta" href="/connect">ChatGPT</a>
		{/if}
	</header>
	{@render children()}
</main>
