import { matchRoute } from './route';

let path = $state(location.pathname);

export const router = {
	get route() {
		return matchRoute(path);
	},
	get path() {
		return path;
	}
};

export function navigate(to: string) {
	history.pushState({}, '', to);
	path = location.pathname;
	scrollTo(0, 0);
}

addEventListener('popstate', () => (path = location.pathname));

// Plain links navigate in the page; new-tab and modified clicks are left to the browser.
export function interceptLinkClicks(event: MouseEvent) {
	const link = event.target instanceof Element ? event.target.closest('a') : null;

	if (!link || event.defaultPrevented || event.button !== 0) return;

	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

	if (link.target !== '' || link.origin !== location.origin) return;
	event.preventDefault();
	navigate(link.pathname);
}
