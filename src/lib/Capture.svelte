<script lang="ts">
	import { flushSync, onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { newRambleId, parseRambleId, parseRevision, type RambleId, type Revision } from '$lib/ids';
	import { IDLE_GAP_MS } from '$lib/idle';
	import { splitRamble } from '$lib/split-client';
	import { z } from 'zod';

	// `revision` is what the server last confirmed for `id`; saves are based on it.
	type Draft = { id: RambleId; body: string; revision: Revision | null };

	type SaveStatus = 'empty' | 'saving' | 'saved' | 'failed';

	let {
		draft,
		model
	}: { draft: (Draft & { updatedAt: Date }) | null; model: string | null } = $props();

	const nullableRevision = z
		.string()
		.nullable()
		.transform((raw) => (raw === null ? null : parseRevision(raw)));

	const backupSchema = z.object({ id: z.string(), body: z.string(), revision: nullableRevision });

	const saveReplySchema = z.object({ id: z.string(), revision: nullableRevision });

	const endReplySchema = z.object({
		toSplit: z.object({ id: z.string(), body: z.string() }).nullable()
	});

	// One backup per tab, so tabs never overwrite or clear each other's text.
	const BACKUP_PREFIX = 'data-dump:draft:';

	// Held for as long as a tab is open; a backup whose lock is free was left
	// by a tab that closed or crashed.
	const TAB_LOCK_PREFIX = 'data-dump:tab:';

	// R2 takes at most one write per second to a ramble.
	const MIN_SAVE_GAP_MS = 1500;

	const STATUS_TEXT: Record<SaveStatus, string> = {
		empty: '',
		saving: 'saving…',
		saved: 'saved',
		failed: 'not saved'
	};

	const tabId = crypto.randomUUID();

	const backupKey = `${BACKUP_PREFIX}${tabId}`;

	let text = $state('');

	let status = $state<SaveStatus>('empty');

	let endsInFlight = $state(0);

	// `id` is the ramble this box writes to; null until the first character.
	// `acked` is the body the server last confirmed for it, at `revision`.
	// `capture` changes whenever the box starts a new ramble, so replies for
	// an older one are ignored.
	let id: RambleId | null = null;

	let revision: Revision | null = null;

	let acked = '';

	let capture = 0;

	let saveInFlight: Promise<boolean> | null = null;

	let lastSaveAt = 0;

	let lastInputAt = Date.now();

	let saveTimer: ReturnType<typeof setTimeout> | undefined;

	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	function parseBackup(raw: string | null): Draft | null {
		try {
			const backup = backupSchema.safeParse(JSON.parse(raw ?? 'null'));

			if (!backup.success) return null;
			const backupId = parseRambleId(backup.data.id);

			return backupId ? { id: backupId, body: backup.data.body, revision: backup.data.revision } : null;
		} catch {
			return null;
		}
	}

	function writeBackup() {
		if (id === null) localStorage.removeItem(backupKey);
		else localStorage.setItem(backupKey, JSON.stringify({ id, body: text, revision }));
	}

	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	type SaveReply = { ok: true; id: RambleId; revision: Revision | null } | { ok: false; retryAfterMs: number | null };

	async function putDraft(draft: Draft): Promise<SaveReply> {
		await sleep(Math.max(0, lastSaveAt + MIN_SAVE_GAP_MS - Date.now()));
		lastSaveAt = Date.now();

		try {
			const response = await fetch('/api/ramble', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: draft.id, body: draft.body, base: draft.revision })
			});

			if (response.status === 503) {
				const seconds = Number(response.headers.get('retry-after'));

				return { ok: false, retryAfterMs: Math.max(MIN_SAVE_GAP_MS, (seconds || 0) * 1000) };
			}

			const reply = saveReplySchema.safeParse(response.ok ? await response.json() : null);
			const savedId = reply.success ? parseRambleId(reply.data.id) : null;

			if (!reply.success || savedId === null) {
				console.warn(`autosave failed with status ${response.status}`);

				return { ok: false, retryAfterMs: null };
			}

			return { ok: true, id: savedId, revision: reply.data.revision };
		} catch (error) {
			console.warn('autosave failed', error);

			return { ok: false, retryAfterMs: null };
		}
	}

	async function saveCurrent(target: { capture: number; draft: Draft }): Promise<boolean> {
		const reply = await putDraft(target.draft);

		if (target.capture !== capture) return reply.ok;

		if (!reply.ok) {
			// The text stays in the backup either way; a busy server is retried on its own.
			if (reply.retryAfterMs === null) status = 'failed';
			else setTimeout(() => save(() => text), reply.retryAfterMs);

			return false;
		}

		id = reply.id;
		revision = reply.revision;
		acked = target.draft.body;
		status = text === acked ? 'saved' : 'saving';

		if (text === acked) localStorage.removeItem(backupKey);
		else writeBackup();

		return true;
	}

	// One save in flight at a time; later text waits and goes in the next one.
	async function save(pickBody: () => string): Promise<boolean> {
		while (saveInFlight) await saveInFlight;
		const body = pickBody();

		if (id === null) return true;

		if (body === acked && revision !== null) {
			if (text === acked) status = 'saved';

			return true;
		}

		status = 'saving';
		saveInFlight = saveCurrent({ capture, draft: { id, body, revision } }).finally(
			() => (saveInFlight = null)
		);

		return saveInFlight;
	}

	function scheduleSave() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => save(() => text), MIN_SAVE_GAP_MS);
	}

	function scheduleIdleEnd() {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(endCurrent, IDLE_GAP_MS);
	}

	function startCapture(body: string) {
		capture += 1;
		acked = '';
		revision = null;
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

			const reply = endReplySchema.safeParse(response.ok ? await response.json() : null);

			if (!reply.success) console.warn(`ending ramble failed with status ${response.status}`);
			const toSplit = reply.success ? reply.data.toSplit : null;
			const splitId = toSplit && parseRambleId(toSplit.id);

			if (toSplit && splitId) await splitRamble({ ramble: { id: splitId, body: toSplit.body }, model });
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

	const tabIsGone = (otherTabId: string) =>
		navigator.locks.request(`${TAB_LOCK_PREFIX}${otherTabId}`, { ifAvailable: true }, (lock) => lock !== null);

	// Backups left by tabs that are gone, other than ones the server already holds.
	async function orphanedBackups(): Promise<{ key: string; draft: Draft }[]> {
		const keys = Object.keys(localStorage).filter(
			(key) => key.startsWith(BACKUP_PREFIX) && key !== backupKey
		);

		const found: { key: string; draft: Draft }[] = [];

		for (const key of keys) {
			if (!(await tabIsGone(key.slice(BACKUP_PREFIX.length)))) continue;
			const backup = parseBackup(localStorage.getItem(key));

			if (!backup || (backup.id === draft?.id && backup.body === draft.body)) {
				localStorage.removeItem(key);
			} else {
				found.push({ key, draft: backup });
			}
		}

		return found;
	}

	// A backup that does not go into the box is saved as it is. Its record
	// is removed only once the server has confirmed that exact text.
	async function saveOrphan({ key, draft }: { key: string; draft: Draft }) {
		for (;;) {
			const reply = await putDraft(draft);

			if (reply.ok) {
				localStorage.removeItem(key);

				return;
			}

			if (reply.retryAfterMs === null) return;
			await sleep(reply.retryAfterMs);
		}
	}

	async function restore() {
		const [first, ...rest] = await orphanedBackups();

		if (first) {
			id = first.draft.id;
			text = first.draft.body;
			revision = first.draft.revision;
			acked = '';
			writeBackup();
			localStorage.removeItem(first.key);
			void save(() => text);
			scheduleIdleEnd();
		} else if (draft) {
			id = draft.id;
			text = draft.body;
			revision = draft.revision;
			acked = draft.body;
			lastInputAt = draft.updatedAt.getTime();
			status = 'saved';
			idleTimer = setTimeout(endCurrent, Math.max(0, lastInputAt + IDLE_GAP_MS - Date.now()));
		}

		for (const orphan of rest) await saveOrphan(orphan);
	}

	onMount(() => {
		void navigator.locks.request(`${TAB_LOCK_PREFIX}${tabId}`, () => new Promise(() => {}));
		void restore();

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
