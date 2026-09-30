import { describe, expect, it } from 'vitest';
import { matchRoute } from './route';

describe('matchRoute', () => {
	it.each([
		['/', { page: 'home' }],
		['/connect', { page: 'connect' }],
		['/connect/', { page: 'connect' }],
		['/thought/abc', { page: 'thought', id: 'abc' }],
		['/ramble/abc', { page: 'ramble', id: 'abc' }],
		['/thought', { page: 'not-found' }],
		['/thought/abc/more', { page: 'not-found' }],
		['/connect/x', { page: 'not-found' }],
		['/elsewhere', { page: 'not-found' }]
	])('%s', (path, route) => {
		expect(matchRoute(path)).toEqual(route);
	});
});
