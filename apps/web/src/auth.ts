// SPDX-License-Identifier: AGPL-3.0-only
import { createAuthClient } from "better-auth/react";

export const auth = createAuthClient();

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
