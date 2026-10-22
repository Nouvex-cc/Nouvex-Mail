// SPDX-License-Identifier: AGPL-3.0-only
// Accounts are made on the server, not on the sign-in page, so a public instance only has the people its admin added.
// Nobody here ever knows their password: each command prints a link where the person picks it themselves.
//   bun src/user.ts add <email> <name>     a new account
//   bun src/user.ts reset <email>          for someone who forgot their password; their mail is fetched again
import { eq } from "drizzle-orm";
import { auth } from "./auth";
import { db } from "./db";
import { userKey } from "./db/schema";

const ctx = await auth.$context;
const week = 7 * 24 * 60 * 60 * 1000;

// Lets the holder of the link set a password once.
async function link(userId: string) {
	const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
	await ctx.internalAdapter.createVerificationValue({
		identifier: `invite:${token}`,
		value: userId,
		expiresAt: new Date(Date.now() + week),
	});
	// After the #, so the token stays out of proxy and server logs.
	return `${process.env.WEB_ORIGIN ?? "http://localhost:5173"}/welcome#${token}`;
}

export async function addUser(email: string, name: string) {
	if (await ctx.internalAdapter.findUserByEmail(email.toLowerCase()))
		throw new Error(`${email} already has an account.`);
	const user = await ctx.internalAdapter.createUser(
		{ email: email.toLowerCase(), name, emailVerified: false },
		{ method: "email-password" },
	);
	return { user, link: await link(user.id) };
}

// The old password and key go, and with the key everything stored for this person can't be read anymore: the engine
// drops it and fetches the mail again once they've set a new password.
export async function resetUser(email: string) {
	const found = await ctx.internalAdapter.findUserByEmail(email.toLowerCase());
	if (!found) throw new Error(`${email} has no account.`);
	const id = found.user.id;
	const credential = await ctx.internalAdapter.findCredentialAccount(id);
	if (credential) await ctx.internalAdapter.deleteAccount(credential.id);
	await ctx.internalAdapter.deleteUserSessions(id);
	await db.delete(userKey).where(eq(userKey.userId, id));
	return link(id);
}

if (import.meta.main) {
	const [command, email, ...name] = process.argv.slice(2);
	try {
		if (!email || (command !== "add" && command !== "reset"))
			throw new Error("usage: user add <email> <name> | user reset <email>");
		const url =
			command === "add"
				? (await addUser(email, name.join(" ") || email.split("@")[0] || email)).link
				: await resetUser(email);
		console.log(`Send this link to ${email}, it works once within a week:\n${url}`);
		process.exit(0);
	} catch (e) {
		console.error((e as Error).message);
		process.exit(1);
	}
}
