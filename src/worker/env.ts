import type { UserId } from './access';
import type { UserData } from './user-data';

// The Durable Object calls the API uses, by user. Kept narrower than the
// generated namespace type so tests can stand in for it.
type Async<Methods> = {
	[Name in keyof Methods]: Methods[Name] extends (...args: infer Args) => infer Result
		? (...args: Args) => Promise<Result>
		: never;
};

export interface UserDataNamespace {
	getByName(
		name: string
	): Async<
		Pick<
			UserData,
			| 'home'
			| 'saveDraft'
			| 'endRamble'
			| 'finishSplit'
			| 'ramble'
			| 'thought'
			| 'editRamble'
			| 'editThought'
			| 'deleteThought'
		>
	>;
}

export interface AppEnv {
	Bindings: {
		USER_DATA: UserDataNamespace;
		ACCESS_TEAM_DOMAIN?: string;
		ACCESS_AUD?: string;
		CHATGPT_MODEL?: string;
		// Only read in dev, where it stands in for Cloudflare Access.
		DEV_USER_ID?: string;
	};
	Variables: { userId: UserId };
}
