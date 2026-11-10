// SPDX-License-Identifier: AGPL-3.0-only
// Amazon SES reports bounces and complaints through SNS. AWS signs every SNS message; only ours (SES_TOPIC_ARN)
// counts, since any AWS customer's topic would be signed just as well.
import { createVerify } from "node:crypto";

export type Sns = {
	Type: string;
	MessageId: string;
	TopicArn: string;
	Message: string;
	Timestamp: string;
	Subject?: string;
	Token?: string;
	SubscribeURL?: string;
	SignatureVersion: string;
	Signature: string;
	SigningCertURL: string;
};

/** How SNS is reached; tests put a fake here. */
export const snsDeps = { fetch: fetch as typeof fetch };

// The fields each kind of message is signed over, in this order (docs.aws.amazon.com/sns, verifying signatures).
const signed: Record<string, (keyof Sns)[]> = {
	Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
	SubscriptionConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
};

const certs = new Map<string, Promise<string>>();

/** Whether AWS's own SNS signed this one. */
export const fromAws = (url: string | undefined) => {
	if (!url) return false;
	const u = URL.parse(url);
	return !!u && u.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname);
};

export async function verify(m: Sns) {
	const fields = signed[m.Type];
	if (!fields || !fromAws(m.SigningCertURL)) return false;
	const text = fields
		.filter((k) => m[k] !== undefined)
		.map((k) => `${k}\n${m[k]}\n`)
		.join("");
	let pem = certs.get(m.SigningCertURL);
	if (!pem) {
		pem = snsDeps.fetch(m.SigningCertURL).then((r) => r.text());
		certs.set(m.SigningCertURL, pem);
	}
	const check = createVerify(m.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1");
	check.update(text);
	try {
		return check.verify(await pem, m.Signature, "base64");
	} catch {
		certs.delete(m.SigningCertURL);
		return false;
	}
}

export type Report = {
	kind: "bounce" | "complaint";
	subject: string;
	recipients: { address: string; reason: string }[];
};

/** What an SES event says for the sender, or nothing to tell: a bounce SES still retries, or another event. */
export function report(message: string): { accountId: string; report: Report } | undefined {
	const e = JSON.parse(message) as {
		eventType?: string;
		notificationType?: string;
		mail?: { tags?: Record<string, string[]>; commonHeaders?: { subject?: string } };
		bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress: string; diagnosticCode?: string }[] };
		complaint?: { complainedRecipients?: { emailAddress: string }[] };
	};
	const accountId = e.mail?.tags?.account?.[0];
	const subject = e.mail?.commonHeaders?.subject ?? "";
	const kind = e.eventType ?? e.notificationType;
	if (!accountId) return;
	if (kind === "Bounce" && e.bounce?.bounceType === "Permanent")
		return {
			accountId,
			report: {
				kind: "bounce",
				subject,
				recipients: (e.bounce.bouncedRecipients ?? []).map((r) => ({
					address: r.emailAddress,
					reason: r.diagnosticCode ?? "",
				})),
			},
		};
	if (kind === "Complaint")
		return {
			accountId,
			report: {
				kind: "complaint",
				subject,
				recipients: (e.complaint?.complainedRecipients ?? []).map((r) => ({ address: r.emailAddress, reason: "" })),
			},
		};
}
