import type { R2Bucket } from '@cloudflare/workers-types';

declare global {
	namespace App {
		interface Platform {
			env: {
				DATA: R2Bucket;
				ACCESS_TEAM_DOMAIN?: string;
				ACCESS_AUD?: string;
				PUBLIC_CHATGPT_MODEL?: string;
				// Only read when running `pnpm dev`.
				DEV_USER_ID?: string;
			};
		}
	}
}

export {};
