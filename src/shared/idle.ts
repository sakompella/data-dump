export const IDLE_GAP_MS = 10 * 60 * 1000;

export const isIdle = (lastActivity: Date, now: Date): boolean =>
	now.getTime() - lastActivity.getTime() > IDLE_GAP_MS;
