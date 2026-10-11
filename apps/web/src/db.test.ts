// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { type Message, once } from "./db";

const mail = (id: string, messageId: string, mailboxId: string) => ({ id, messageId, mailboxId }) as Message;

test("a mail in two places counts once, as the preferred copy", () => {
	const sent = mail("1", "<a@x>", "sent");
	const received = mail("2", "<a@x>", "inbox");
	const reply = mail("3", "<b@x>", "inbox");
	expect(once([sent, received, reply])).toEqual([sent, reply]);
	expect(once([sent, received, reply], (m) => m.mailboxId === "inbox")).toEqual([received, reply]);
	// Without a Message-ID nothing can be told apart, so nothing is dropped.
	expect(once([mail("4", "", "inbox"), mail("5", "", "inbox")])).toHaveLength(2);
});
