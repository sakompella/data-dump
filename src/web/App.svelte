<script lang="ts">
	import { onMount } from 'svelte';
	import type { ConnectionStatus } from './chatgpt/auth';
	import ConnectPage from './pages/ConnectPage.svelte';
	import HomePage from './pages/HomePage.svelte';
	import RamblePage from './pages/RamblePage.svelte';
	import ThoughtPage from './pages/ThoughtPage.svelte';
	import { interceptLinkClicks, router } from './router.svelte';
	import { session } from './session.svelte';
	import { chatgptAuth } from './split-client';

	// Tokens live in this browser, so the header learns the status here.
	let chatgpt = $state<ConnectionStatus | null>(null);

	const refresh = () => (chatgpt = chatgptAuth().status());

	$effect(() => {
		void router.path;
		refresh();
	});

	onMount(() => {
		window.addEventListener('storage', refresh);

		return () => window.removeEventListener('storage', refresh);
	});
</script>

<svelte:window onclick={interceptLinkClicks} />

<main>
	<header class="site">
		<h1><a href="/">data-dump</a></h1>
		{#if chatgpt === 'needs-reconnect'}
			<a class="failed" href="/connect">reconnect ChatGPT</a>
		{:else if chatgpt}
			<a class="meta" href="/connect">ChatGPT</a>
		{/if}
	</header>
	{#if session.expired}
		<p class="error">Signed out. Your text is kept here. Reload the page to sign in again.</p>
	{/if}
	<!-- A new key remounts the page, so each route starts with fresh state. -->
	{#key router.path}
		{#if router.route.page === 'home'}
			<HomePage />
		{:else if router.route.page === 'connect'}
			<ConnectPage />
		{:else if router.route.page === 'thought'}
			<ThoughtPage id={router.route.id} />
		{:else if router.route.page === 'ramble'}
			<RamblePage id={router.route.id} />
		{:else}
			<p class="empty">Nothing here. <a href="/">Back</a></p>
		{/if}
	{/key}
</main>
