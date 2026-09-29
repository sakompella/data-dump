<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children, data } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<main>
	<header class="site">
		<h1><a href="/">data-dump</a></h1>
		{#if data.chatgpt === 'needs-reconnect'}
			<a class="failed" href="/connect">reconnect ChatGPT</a>
		{:else if data.chatgpt}
			<a class="meta" href="/connect">ChatGPT</a>
		{/if}
	</header>
	{@render children()}
</main>
