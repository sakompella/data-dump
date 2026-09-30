import type { UserId } from '$lib/server/access';
import type { DocumentBucket } from '$lib/server/store';

declare global {
	namespace App {
		interface Locals {
			userId: UserId;
		}

		interface Platform {
			env: {
				// The R2 bucket, typed as the subset the store uses. R2Bucket's own type
				// names workers-types' Headers, which the DOM Headers type does not match.
				DATA: DocumentBucket;
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
