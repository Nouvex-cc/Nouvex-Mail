// SPDX-License-Identifier: AGPL-3.0-only
import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const auth = createAuthClient({ plugins: [passkeyClient(), twoFactorClient()] });

let signedIn: ReturnType<typeof auth.getSession> | undefined;

/**
 * The session, asked for once per page load. Routes check it on every navigation, and opening a message is one.
 * Signing out reloads the page, which starts over; a missing session is asked for again next time.
 */
export function session() {
	signedIn ??= auth.getSession().then((res) => {
		if (!res.data) signedIn = undefined;
		return res;
	});
	return signedIn;
}
