<script lang="ts">
	import { flushSync, onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { newRambleId, parseRambleId, type RambleId } from '$lib/ids';
	import { IDLE_GAP_MS } from '$lib/idle';

	type Draft = { id: RambleId; body: string };
	type SaveStatus = 'empty' | 'saving' | 'saved' | 'failed';

	let { draft }: { draft: (Draft & { updatedAt: Date }) | null } = $props();

	const BACKUP_KEY = 'data-dump:draft';
	const SAVE_DELAY_MS = 800;
	const STATUS_TEXT: Record<SaveStatus, string> = {
		empty: '',
		saving: 'saving…',
		saved: 'saved',
		failed: 'not saved'
	};

	let text = $state('');
	let status = $state<SaveStatus>('empty');
	let endsInFlight = $state(0);

	// `id` is the ramble this box writes to; null until the first character.
	// `acked` is the body the server last confirmed for it. `capture` changes
	// whenever the box starts a new ramble, so replies for an older one are ignored.
	let id: RambleId | null = null;
	let acked = '';
	let capture = 0;
	let saveInFlight: Promise<boolean> | null = null;
	let lastInputAt = Date.now();
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	function readBackup(): Draft | null {
		try {
			const raw: unknown = JSON.parse(localStorage.getItem(BACKUP_KEY) ?? 'null');
			if (typeof raw !== 'object' || raw === null) return null;
			if (!('id' in raw && 'body' in raw) || typeof raw.id !== 'string') return null;
			const backupId = parseRambleId(raw.id);
			return backupId && typeof raw.body === 'string' ? { id: backupId, body: raw.body } : null;
		} catch {
			return null;
		}
	}

	function writeBackup() {
		if (id === null) localStorage.removeItem(BACKUP_KEY);
		else localStorage.setItem(BACKUP_KEY, JSON.stringify({ id, body: text }));
	}

	async function putDraft(target: { capture: number; id: RambleId; body: string }) {
		try {
			const response = await fetch('/api/ramble', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: target.id, body: target.body })
			});
			const reply: unknown = response.ok ? await response.json() : null;
			const savedId =
				typeof reply === 'object' && reply !== null && 'id' in reply && typeof reply.id === 'string'
					? parseRambleId(reply.id)
					: null;
			if (savedId === null) throw new Error(`save failed with status ${response.status}`);
			if (target.capture !== capture) return true;
			id = savedId;
			acked = target.body;
			status = text === acked ? 'saved' : 'saving';
			if (text === acked) localStorage.removeItem(BACKUP_KEY);
			else writeBackup();
			return true;
		} catch (error) {
			console.warn('autosave failed', error);
			if (target.capture === capture) status = 'failed';
			return false;
		}
	}

	// One save in flight at a time; later text waits and goes in the next one.
	async function save(pickBody: () => string): Promise<boolean> {
		while (saveInFlight) await saveInFlight;
		const body = pickBody();
		if (id === null) return true;
		if (body === acked) {
			if (text === acked) status = 'saved';
			return true;
		}
		status = 'saving';
		saveInFlight = putDraft({ capture, id, body }).finally(() => (saveInFlight = null));
		return saveInFlight;
	}

	function scheduleSave() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => save(() => text), SAVE_DELAY_MS);
	}

	function scheduleIdleEnd() {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(endCurrent, IDLE_GAP_MS);
	}

	function startCapture(body: string) {
		capture += 1;
		acked = '';
		text = body;
		id = body === '' ? null : newRambleId();
		lastInputAt = Date.now();
		status = body === '' ? 'empty' : 'saving';
		writeBackup();
		if (body !== '') {
			scheduleSave();
			scheduleIdleEnd();
		}
	}

	async function endOnServer(endingId: RambleId) {
		endsInFlight += 1;
		try {
			const response = await fetch('/api/ramble/end', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: endingId })
			});
			if (!response.ok) console.warn(`ending ramble failed with status ${response.status}`);
		} catch (error) {
			console.warn('ending ramble failed; it will end on a later page load', error);
		} finally {
			endsInFlight -= 1;
			await invalidateAll();
		}
	}

	// Saves exactly what is in the box now, then ends that ramble. Text typed
	// while the save runs starts the next ramble.
	async function endCurrent() {
		clearTimeout(idleTimer);
		if (id === null) return;
		const snapshot = text;
		clearTimeout(saveTimer);
		if (!(await save(() => snapshot)) || id === null) return;
		const endingId = id;
		startCapture(text.startsWith(snapshot) ? text.slice(snapshot.length) : text);
		void endOnServer(endingId);
	}

	const isPastIdleGap = () => id !== null && Date.now() - lastInputAt > IDLE_GAP_MS;

	function endIfIdle() {
		if (isPastIdleGap()) void endCurrent();
	}

	// Coming back after the idle gap: clear the box before the keystroke
	// lands, so the new ramble never starts with the old text.
	function onbeforeinput() {
		if (!isPastIdleGap() || id === null) return;
		if (text !== acked || saveInFlight) {
			void endCurrent();
			return;
		}
		const endingId = id;
		startCapture('');
		flushSync();
		void endOnServer(endingId);
	}

	function oninput() {
		lastInputAt = Date.now();
		if (id === null && text !== '') id = newRambleId();
		writeBackup();
		status = id === null ? 'empty' : 'saving';
		scheduleSave();
		scheduleIdleEnd();
	}

	onMount(() => {
		const backup = readBackup();
		const backupDiffers = backup && !(backup.id === draft?.id && backup.body === draft.body);
		if (backup && backupDiffers) {
			id = backup.id;
			text = backup.body;
			acked = backup.id === draft?.id ? draft.body : '';
			void save(() => text);
			scheduleIdleEnd();
		} else if (draft) {
			id = draft.id;
			text = draft.body;
			acked = draft.body;
			lastInputAt = draft.updatedAt.getTime();
			status = 'saved';
			idleTimer = setTimeout(endCurrent, Math.max(0, lastInputAt + IDLE_GAP_MS - Date.now()));
		}
		return () => {
			clearTimeout(saveTimer);
			clearTimeout(idleTimer);
		};
	});
</script>

<svelte:window onfocus={endIfIdle} />
<svelte:document onvisibilitychange={endIfIdle} />

<section class="capture">
	<!-- svelte-ignore a11y_autofocus -->
	<textarea
		bind:value={text}
		{onbeforeinput}
		{oninput}
		autofocus
		rows="12"
		placeholder="Type or paste anything."
		aria-label="Ramble"
	></textarea>
	<div class="capture-bar">
		<button type="button" onclick={endCurrent}>New ramble</button>
		<span class="status" class:failed={status === 'failed'}>{STATUS_TEXT[status]}</span>
		{#if status === 'failed'}
			<button type="button" class="small" onclick={() => save(() => text)}>Retry</button>
		{/if}
		{#if endsInFlight > 0}<span class="status">splitting…</span>{/if}
	</div>
</section>
