export type Route =
	| { page: 'home' }
	| { page: 'connect' }
	| { page: 'thought'; id: string }
	| { page: 'ramble'; id: string }
	| { page: 'not-found' };

export function matchRoute(path: string): Route {
	const [, first, id, ...rest] = path.replace(/\/+$/, '').split('/');

	if (first === undefined || first === '') return { page: 'home' };

	if (rest.length > 0) return { page: 'not-found' };

	if (first === 'connect' && id === undefined) return { page: 'connect' };

	if (first === 'thought' && id) return { page: 'thought', id };

	if (first === 'ramble' && id) return { page: 'ramble', id };

	return { page: 'not-found' };
}
