// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "bun:test";
import { createSign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { report, type Sns, snsDeps, verify } from "./sns";

// A key and certificate standing in for AWS's.
const dir = mkdtempSync(join(tmpdir(), "sns-"));
Bun.spawnSync([
	"openssl",
	"req",
	"-x509",
	"-newkey",
	"rsa:2048",
	"-nodes",
	"-keyout",
	join(dir, "key.pem"),
	"-out",
	join(dir, "cert.pem"),
	"-days",
	"1",
	"-subj",
	"/CN=sns.amazonaws.com",
]);
const key = readFileSync(join(dir, "key.pem"), "utf8");
const cert = readFileSync(join(dir, "cert.pem"), "utf8");
const certURL = "https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-test.pem";

/** An SNS message signed the way AWS signs it. */
export function signed(m: Omit<Sns, "Signature" | "SignatureVersion" | "SigningCertURL">): Sns {
	const order: (keyof Sns)[] =
		m.Type === "Notification"
			? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
			: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
	const all = m as Sns;
	const text = order
		.filter((k) => all[k] !== undefined)
		.map((k) => `${k}\n${all[k]}\n`)
		.join("");
	const sign = createSign("RSA-SHA256");
	sign.update(text);
	return { ...m, SignatureVersion: "2", SigningCertURL: certURL, Signature: sign.sign(key, "base64") };
}

export const withCert = () => {
	const before = snsDeps.fetch;
	const asked: string[] = [];
	snsDeps.fetch = (async (url: string) => {
		asked.push(String(url));
		return new Response(String(url) === certURL ? cert : "ok");
	}) as typeof fetch;
	return { asked, restore: () => (snsDeps.fetch = before) };
};

const note = (message: unknown) =>
	signed({
		Type: "Notification",
		MessageId: "1",
		TopicArn: "arn:aws:sns:eu-central-1:1:ses",
		Message: JSON.stringify(message),
		Timestamp: "2026-11-10T20:00:00.000Z",
	});

test("only what AWS signed, from AWS's own certificate host", async () => {
	const cert = withCert();
	try {
		const m = note({ eventType: "Bounce" });
		expect(await verify(m)).toBe(true);
		expect(await verify({ ...m, Message: "{}" })).toBe(false);
		expect(await verify({ ...m, SigningCertURL: "https://evil.example/cert.pem" })).toBe(false);
		expect(await verify({ ...m, SigningCertURL: "https://sns.eu-central-1.amazonaws.com.evil.example/c.pem" })).toBe(
			false,
		);
	} finally {
		cert.restore();
	}
});

test("tells the sender about bounces SES gave up on and complaints", () => {
	const mail = { tags: { account: ["a1"] }, commonHeaders: { subject: "Plan" } };
	expect(
		report(
			JSON.stringify({
				eventType: "Bounce",
				mail,
				bounce: {
					bounceType: "Permanent",
					bouncedRecipients: [{ emailAddress: "x@y.z", diagnosticCode: "550 no such user" }],
				},
			}),
		),
	).toEqual({
		accountId: "a1",
		report: { kind: "bounce", subject: "Plan", recipients: [{ address: "x@y.z", reason: "550 no such user" }] },
	});
	expect(report(JSON.stringify({ eventType: "Bounce", mail, bounce: { bounceType: "Transient" } }))).toBeUndefined();
	expect(
		report(
			JSON.stringify({
				eventType: "Complaint",
				mail,
				complaint: { complainedRecipients: [{ emailAddress: "x@y.z" }] },
			}),
		)?.report.kind,
	).toBe("complaint");
	expect(report(JSON.stringify({ eventType: "Bounce", mail: {} }))).toBeUndefined();
});

// Needs the database and NATS (docker compose up -d).
test.skipIf(!process.env.DATABASE_URL || !process.env.NATS_URL)(
	"the webhook takes our topic only and counts",
	async () => {
		const { app } = await import("./app");
		const { db } = await import("./db");
		const { mailAccount, sendCount, sendEvent, user } = await import("./db/schema");
		const { eq } = await import("drizzle-orm");
		const cert = withCert();
		// CI runs no engine, so the stream it makes may not be there.
		const { jetstreamManager } = await import("@nats-io/jetstream");
		const { nats } = await import("./nats");
		const jsm = await jetstreamManager((await nats()).nc);
		await jsm.streams.add({ name: "COMMANDS", subjects: ["cmd.>"], retention: "workqueue" }).catch(() => {});
		process.env.SES_TOPIC_ARN = "arn:aws:sns:eu-central-1:1:ses";
		const id = crypto.randomUUID();
		await db.insert(user).values({
			id,
			name: "Lena",
			email: `${id}@test.dev`,
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		await db.insert(mailAccount).values({
			id,
			userId: id,
			email: `lena@${id}.test`,
			kind: "hosted",
			imapHost: "",
			imapPort: 0,
			smtpHost: "",
			smtpPort: 0,
			username: "",
			secret: new Uint8Array(),
		});
		await db.insert(sendCount).values({ accountId: id, day: new Date().toISOString().slice(0, 10), count: 500 });
		const post = (m: Sns) => app.request("/webhooks/ses", { method: "POST", body: JSON.stringify(m) });
		try {
			const bounce = note({
				eventType: "Bounce",
				mail: { tags: { account: [id] }, commonHeaders: { subject: "Plan" } },
				bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "x@y.z" }] },
			});
			expect((await post({ ...bounce, TopicArn: "arn:aws:sns:eu-central-1:2:theirs" })).status).toBe(403);
			expect((await post(bounce)).status).toBe(200);
			expect(await db.select().from(sendEvent).where(eq(sendEvent.accountId, id))).toHaveLength(1);
			// One bounce in 500 is no reason to stop; one complaint in 500 is.
			const paused = async () =>
				(await db.select().from(mailAccount).where(eq(mailAccount.id, id)))[0]?.sendingPausedAt != null;
			expect(await paused()).toBe(false);
			const complaint = note({
				eventType: "Complaint",
				mail: { tags: { account: [id] }, commonHeaders: { subject: "Plan" } },
				complaint: { complainedRecipients: [{ emailAddress: "x@y.z" }] },
			});
			expect((await post(complaint)).status).toBe(200);
			expect(await paused()).toBe(true);

			const confirm = signed({
				Type: "SubscriptionConfirmation",
				MessageId: "2",
				TopicArn: "arn:aws:sns:eu-central-1:1:ses",
				Message: "Confirm",
				Token: "t",
				SubscribeURL: "https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=t",
				Timestamp: "2026-11-10T20:00:00.000Z",
			});
			expect((await post(confirm)).status).toBe(200);
			expect(cert.asked).toContain(confirm.SubscribeURL as string);
		} finally {
			cert.restore();
			await db.delete(user).where(eq(user.id, id));
		}
	},
	// Loading the whole API for the first time takes a few seconds on CI's runners.
	30_000,
);
