<script lang="ts">
	import { flushSync, onMount } from 'svelte';
	import { z } from 'zod';
	import type { RambleId } from '../../shared/domain';
	import { newRambleId, parseRambleId, parseRevision, type Revision } from '../../shared/ids';
	import { IDLE_GAP_MS } from '../../shared/idle';
	import { api, type HomeData } from '../api';
	import { trackSave } from '../pending-saves';
	import { browserStorage, guardStore, writeConfirmed } from '../safe-storage';
	import { splitRamble } from '../split-client';

	// `revision` is what the server last confirmed for `id`; saves are based on it.
	type Draft = { id: RambleId; body: string; revision: Revision | null };

	// The ramble the box is writing to, or one that was just ended and is being finished.
	// `acked` is the body the server last confirmed for `id`, at `revision`.
	interface Capture {
		readonly key: string;
		id: RambleId | null;
		revision: Revision | null;
		acked: string;
		// Set when the capture ends: its text from then on, whatever is typed after.
		frozen: string | null;
		inFlight: Promise<boolean> | null;
		saveTimer: ReturnType<typeof setTimeout> | undefined;
	}

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

	// One backup per capture (`<prefix><tab>~<n>`), so neither tabs nor an ended
	// capture and the next one overwrite each other's text.
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

	let captures = 0;

	const newCapture = (): Capture => ({
		key: `${BACKUP_PREFIX}${tabId}~${(captures += 1)}`,
		id: null,
		revision: null,
		acked: '',
		frozen: null,
		inFlight: null,
		saveTimer: undefined
	});

	// Set when the browser refused a backup; saving to the server carries on.
	let backupFailed = $state(false);

	const store = guardStore(browserStorage(), () => (backupFailed = true));

	let text = $state('');

	let status = $state<SaveStatus>('empty');

	let endsInFlight = $state(0);

	let current = newCapture();

	// Captures that ended but could not be saved; the Retry button tries them again.
	let failedEnds: Capture[] = [];

	let earlierUnsaved = $state(0);

	const endJobs = new Set<Promise<void>>();

	let lastInputAt = Date.now();

	let releaseTab: (() => void) | undefined;

	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	// The text of a capture: what is in the box, or what it held when it ended.
	const bodyOf = (capture: Capture) => capture.frozen ?? text;

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

	const encodeBackup = (capture: Capture, body: string) =>
		JSON.stringify({ id: capture.id, body, revision: capture.revision });

	function writeBackup(capture: Capture) {
		if (capture.id === null) store.remove(capture.key);
		else store.write(capture.key, encodeBackup(capture, bodyOf(capture)));
	}

	// The backup goes once the server holds exactly the capture's text.
	function settleBackup(capture: Capture) {
		if (bodyOf(capture) === capture.acked && capture.revision !== null) store.remove(capture.key);
		else writeBackup(capture);
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

	async function saveOnce(capture: Capture, id: RambleId, body: string): Promise<boolean> {
		const reply = await putDraft({ id, body, revision: capture.revision });

		if (!reply.ok) {
			// The text stays in the backup.
			if (capture === current) status = 'failed';

			return false;
		}

		capture.id = reply.id;
		capture.revision = reply.revision;
		capture.acked = body;
		settleBackup(capture);

		if (capture === current) status = text === capture.acked ? 'saved' : 'saving';

		return true;
	}

	// One save in flight per capture at a time. Whatever waits is sent with the
	// capture's text as it is when its turn comes, so text typed after a capture
	// ended can never reach it.
	async function save(capture: Capture): Promise<boolean> {
		while (capture.inFlight) await capture.inFlight;
		const body = bodyOf(capture);

		if (capture.id === null) return true;

		if (body === capture.acked && capture.revision !== null) {
			settleBackup(capture);

			if (capture === current && text === capture.acked) status = 'saved';

			return true;
		}

		if (capture === current) status = 'saving';
		const inFlight = saveOnce(capture, capture.id, body).finally(() => (capture.inFlight = null));
		capture.inFlight = inFlight;

		return inFlight;
	}

	function scheduleSave() {
		const capture = current;
		clearTimeout(capture.saveTimer);
		capture.saveTimer = setTimeout(() => void save(capture), SAVE_DELAY_MS);
	}

	function scheduleIdleEnd() {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(endCurrent, IDLE_GAP_MS);
	}

	async function endOnServer(endingId: RambleId) {
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
		}
	}

	async function finishEnd(capture: Capture) {
		endsInFlight += 1;

		try {
			// The capture's own text is saved first; `id` may have moved to a replacement ramble.
			if (!(await save(capture)) || capture.id === null) {
				failedEnds.push(capture);
				earlierUnsaved = failedEnds.length;
				status = 'failed';

				return;
			}

			await endOnServer(capture.id);
		} finally {
			endsInFlight -= 1;
			onchange();
		}
	}

	function startEndJob(capture: Capture) {
		const job = finishEnd(capture).finally(() => endJobs.delete(job));
		endJobs.add(job);
	}

	// The box starts a new ramble at once; the ended one is frozen at what it held
	// now, saved, and ended in the background. Text typed from here on is the next
	// ramble's and can no longer reach the ended one.
	function endCurrent() {
		clearTimeout(idleTimer);
		const ending = current;

		if (ending.id === null) return;
		clearTimeout(ending.saveTimer);
		ending.frozen = text;
		writeBackup(ending);
		current = newCapture();
		text = '';
		status = 'empty';
		lastInputAt = Date.now();
		startEndJob(ending);
	}

	function retry() {
		void save(current);

		const again = failedEnds.splice(0);
		earlierUnsaved = 0;

		for (const capture of again) startEndJob(capture);
	}

	const isPastIdleGap = () => current.id !== null && Date.now() - lastInputAt > IDLE_GAP_MS;

	function endIfIdle() {
		if (isPastIdleGap()) endCurrent();
	}

	// Coming back after the idle gap: clear the box before the keystroke
	// lands, so the new ramble never starts with the old text.
	function onbeforeinput() {
		if (!isPastIdleGap()) return;
		endCurrent();
		flushSync();
	}

	function oninput() {
		lastInputAt = Date.now();

		if (current.id === null && text !== '') current.id = newRambleId();
		writeBackup(current);
		status = current.id === null ? 'empty' : 'saving';
		scheduleSave();
		scheduleIdleEnd();
	}

	const tabIsGone = (otherTabId: string) =>
		navigator.locks.request(
			`${TAB_LOCK_PREFIX}${otherTabId}`,
			{ ifAvailable: true },
			(lock) => lock !== null
		);

	// Backups left by tabs that are gone. A backup is removed here only if the
	// server already holds exactly that text; one that cannot be read or parsed stays.
	async function orphanedBackups(): Promise<{ key: string; draft: Draft }[]> {
		const found: { key: string; draft: Draft }[] = [];

		for (const key of store.keys() ?? []) {
			const owner = key.slice(BACKUP_PREFIX.length).split('~')[0] ?? '';

			if (!key.startsWith(BACKUP_PREFIX) || owner === tabId) continue;

			if (!(await tabIsGone(owner))) continue;
			const read = store.read(key);
			const backup = read.ok ? parseBackup(read.value) : null;

			if (!backup) continue;

			if (backup.id === draft?.id && backup.body === draft.body) store.remove(key);
			else found.push({ key, draft: backup });
		}

		return found;
	}

	// A backup that does not go into the box is saved as it is. Its record
	// is removed only once the server has confirmed that exact text.
	async function saveOrphan({ key, draft }: { key: string; draft: Draft }) {
		const reply = await putDraft(draft);

		if (reply.ok) store.remove(key);
	}

	async function restore() {
		const [first, ...rest] = await orphanedBackups();
		// Typing during the lock checks above wins; restored text is then saved on its own.
		const untouched = text === '' && current.id === null;

		if (!untouched) {
			for (const orphan of first ? [first, ...rest] : rest) await saveOrphan(orphan);

			return;
		}

		if (first) {
			current.id = first.draft.id;
			text = first.draft.body;
			current.revision = first.draft.revision;
			current.acked = '';

			// The old record goes only once this tab's copy reads back.
			if (writeConfirmed(store, current.key, encodeBackup(current, text))) store.remove(first.key);
			void save(current);
			scheduleIdleEnd();
		} else if (draft) {
			current.id = draft.id;
			text = draft.body;
			current.revision = draft.revision;
			current.acked = draft.body;
			lastInputAt = new Date(draft.updatedAt).getTime();
			status = 'saved';
			idleTimer = setTimeout(endCurrent, Math.max(0, lastInputAt + IDLE_GAP_MS - Date.now()));
		}

		for (const orphan of rest) await saveOrphan(orphan);
	}

	onMount(() => {
		void navigator.locks.request(
			`${TAB_LOCK_PREFIX}${tabId}`,
			() => new Promise<void>((release) => (releaseTab = release))
		);

		void restore();

		return () => {
			clearTimeout(current.saveTimer);
			clearTimeout(idleTimer);
			// Text typed in the last moments is saved, not dropped. The tab lock stays
			// held until every save has settled, so a failed one leaves backups that the
			// next page cannot mistake for an orphan yet, and can once the lock is released.
			trackSave(Promise.all([save(current), ...endJobs]).finally(() => releaseTab?.()));
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
		{#if earlierUnsaved > 0}
			<span class="status failed">unsaved text in an earlier ramble</span>
		{/if}
		{#if status === 'failed' || earlierUnsaved > 0}
			<button type="button" class="small" onclick={retry}>Retry</button>
		{/if}
		{#if backupFailed}<span class="status failed">backup unavailable in this browser</span>{/if}
		{#if endsInFlight > 0}<span class="status">splitting…</span>{/if}
	</div>
</section>
