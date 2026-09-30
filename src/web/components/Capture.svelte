<script lang="ts">
	import { flushSync, onMount } from 'svelte';
	import { z } from 'zod';
	import type { RambleId } from '../../shared/domain';
	import { newRambleId, parseRambleId, parseRevision, type Revision } from '../../shared/ids';
	import { IDLE_GAP_MS } from '../../shared/idle';
	import { api, type HomeData } from '../api';
	import { splitRamble } from '../split-client';

	// `revision` is what the server last confirmed for `id`; saves are based on it.
	type Draft = { id: RambleId; body: string; revision: Revision | null };

	type SaveStatus = 'empty' | 'saving' | 'saved' | 'failed';

	let {
		draft,
		model,
		onchange
	}: {
		draft: HomeData['draft'];
		model: string | null;
		// Called after a ramble has ended and been split, so the page can reload.
		onchange: () => void;
	} = $props();

	const nullableRevision = z
		.number()
		.nullable()
		.transform((raw) => (raw === null ? null : parseRevision(raw)));

	const backupSchema = z.object({ id: z.string(), body: z.string(), revision: nullableRevision });

	// One backup per tab, so tabs never overwrite or clear each other's text.
	const BACKUP_PREFIX = 'data-dump:draft:';

	// Held for as long as a tab is open; a backup whose lock is free was left
	// by a tab that closed or crashed.
	const TAB_LOCK_PREFIX = 'data-dump:tab:';

	// Typing pauses this long before the text is saved.
	const SAVE_DELAY_MS = 800;

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

	type SaveReply = { ok: true; id: RambleId; revision: Revision | null } | { ok: false };

	async function putDraft(draft: Draft): Promise<SaveReply> {
		try {
			const response = await api.ramble.$put({
				json: { id: draft.id, body: draft.body, base: draft.revision }
			});

			if (!response.ok) {
				console.warn(`autosave failed with status ${response.status}`);

				return { ok: false };
			}

			return { ok: true, ...(await response.json()) };
		} catch (error) {
			console.warn('autosave failed', error);

			return { ok: false };
		}
	}

	async function saveCurrent(target: { capture: number; draft: Draft }): Promise<boolean> {
		const reply = await putDraft(target.draft);

		if (target.capture !== capture) return reply.ok;

		if (!reply.ok) {
			// The text stays in the backup.
			status = 'failed';

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
		saveTimer = setTimeout(() => save(() => text), SAVE_DELAY_MS);
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
			const response = await api.ramble.end.$post({ json: { id: endingId } });

			if (response.ok) {
				const { toSplit } = await response.json();

				if (toSplit) await splitRamble({ ramble: toSplit, model });
			} else {
				console.warn(`ending ramble failed with status ${response.status}`);
			}
		} catch (error) {
			console.warn('ending ramble failed; it will end on a later page load', error);
		} finally {
			endsInFlight -= 1;
			onchange();
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
		if ((await putDraft(draft)).ok) localStorage.removeItem(key);
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
			lastInputAt = new Date(draft.updatedAt).getTime();
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
