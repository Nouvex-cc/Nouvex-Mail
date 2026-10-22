// SPDX-License-Identifier: AGPL-3.0-only
// Accounts are made on the server, not on the sign-in page, so a public instance only has the people its admin added.
//   bun src/user.ts add <email> <name>     a new account
//   bun src/user.ts password <email>       a new password, for someone who forgot theirs
// The password comes in on stdin, so it stays out of the shell history.
import { auth } from "./auth";

const ctx = await auth.$context;

const checked = (password: string) => {
	if (password.length < 8) throw new Error("The password needs at least 8 characters.");
	return ctx.password.hash(password);
};

export async function addUser(email: string, name: string, password: string) {
	const hash = await checked(password);
	if (await ctx.internalAdapter.findUserByEmail(email.toLowerCase()))
		throw new Error(`${email} already has an account.`);
	const user = await ctx.internalAdapter.createUser(
		{ email: email.toLowerCase(), name, emailVerified: false },
		{ method: "email-password" },
	);
	await ctx.internalAdapter.linkAccount({
		userId: user.id,
		providerId: "credential",
		accountId: user.id,
		password: hash,
	});
	return user;
}

export async function setPassword(email: string, password: string) {
	const hash = await checked(password);
	const found = await ctx.internalAdapter.findUserByEmail(email.toLowerCase());
	if (!found) throw new Error(`${email} has no account.`);
	await ctx.internalAdapter.updatePassword(found.user.id, hash);
}

if (import.meta.main) {
	const [command, email, ...name] = process.argv.slice(2);
	try {
		if (!email || (command !== "add" && command !== "password"))
			throw new Error("usage: user add <email> <name> | user password <email>, password on stdin");
		const password = (await Bun.stdin.text()).trim();
		if (command === "add") await addUser(email, name.join(" ") || email.split("@")[0] || email, password);
		else await setPassword(email, password);
		console.log(command === "add" ? `Added ${email}.` : `New password set for ${email}.`);
		process.exit(0);
	} catch (e) {
		console.error((e as Error).message);
		process.exit(1);
	}
}
