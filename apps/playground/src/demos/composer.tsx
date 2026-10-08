// SPDX-License-Identifier: AGPL-3.0-only
import { Composer, type OutgoingMessage } from "@nouvex/ui";
import { useState } from "react";

const contacts = [
	{ name: "Lena Hartmann", email: "lena@hartmann.example" },
	{ name: "Jonas Weber", email: "jonas.weber@example.com" },
	{ name: "Mira Okafor", email: "mira@okafor.example" },
	{ name: "Paul Schneider", email: "paul@schneider.example" },
	{ name: "Sofia Rossi", email: "sofia.rossi@example.org" },
	{ name: "Daniel Kim", email: "daniel@kim.example" },
];

export function ComposerDemo() {
	const [last, setLast] = useState<OutgoingMessage>();
	return (
		<div className="grid w-full max-w-2xl gap-2">
			<Composer
				contacts={contacts}
				defaultTo={["lena@hartmann.example"]}
				defaultSubject="Keys for the new flat"
				onSend={setLast}
			/>
			<p className="text-sm text-muted">
				{last
					? `${last.sendAt ? `Scheduled for ${last.sendAt.toLocaleString()}` : "Sent"} to ${[...last.to, ...last.cc, ...last.bcc].join(", ")}, "${last.subject}", ${last.files.length} file(s)`
					: "Nothing sent yet"}
			</p>
		</div>
	);
}
