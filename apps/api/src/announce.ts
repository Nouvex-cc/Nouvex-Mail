// SPDX-License-Identifier: AGPL-3.0-only
// Puts a message into users' inboxes in Nouvex only, as if it had come in; their mail servers never see it. Meant
// for announcing new features with a rich mail (packages/rich). The engine seals it for each user.
//   bun src/announce.ts <mail.eml | -> --to <email>   one user, to try it
//   bun src/announce.ts <mail.eml | -> --all          everyone with an account
// "-" reads the message from stdin, for the server: docker compose exec -T api bun dist/announce.js - --all < mail.eml
import type { MessageSeed } from "@nouvex/schema";
import { s3 } from "bun";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { user } from "./db/schema";
import { nats } from "./nats";

export async function announce(raw: Uint8Array, to: string | "all") {
	const users = await db
		.select({ id: user.id })
		.from(user)
		.where(to === "all" ? undefined : eq(user.email, to.toLowerCase()));
	if (users.length === 0) throw new Error(`No user ${to}.`);
	// One copy for everyone; the engine reads it for each user, and uploads older than a day are swept.
	const uploadId = crypto.randomUUID();
	await s3.write(`upload/${uploadId}`, raw);
	const { js } = await nats();
	for (const u of users) {
		const cmd: MessageSeed = { userId: u.id, uploadId };
		await js.publish("cmd.message.seed", JSON.stringify(cmd));
	}
	return users.length;
}

if (import.meta.main) {
	const [file, flag, email] = process.argv.slice(2);
	try {
		if (!file || !(flag === "--all" || (flag === "--to" && email)))
			throw new Error("usage: announce <mail.eml | -> --to <email> | announce <mail.eml | -> --all");
		const raw = new Uint8Array(await (file === "-" ? Bun.stdin : Bun.file(file)).arrayBuffer());
		const n = await announce(raw, flag === "--all" ? "all" : (email as string));
		console.log(`Queued for ${n} ${n === 1 ? "user" : "users"}. It shows up once the engine has sealed it for each.`);
		process.exit(0);
	} catch (e) {
		console.error((e as Error).message);
		process.exit(1);
	}
}
