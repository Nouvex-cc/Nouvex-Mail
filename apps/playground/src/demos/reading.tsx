// SPDX-License-Identifier: AGPL-3.0-only
import { AttachmentList, AttachmentTile, MailFrame, Thread, ThreadMessage } from "@nouvex/ui";
import { useEffect, useState } from "react";

const day = (offset: number, h: number, m = 0) => {
	const d = new Date();
	d.setDate(d.getDate() + offset);
	d.setHours(h, m, 0, 0);
	return d;
};

const newsletter = `<style>.card{border-radius:12px;padding:20px;background:#f6f3ef}</style>
<div class="card">
	<h2 style="margin:0 0 8px">Your flat, ready on Friday</h2>
	<p>Hi Mateo, the handover is confirmed for <strong>Friday at 18:00</strong>.</p>
	<img src="https://images.example.com/keys.jpg" alt="Keys on a table" width="480" />
	<p>Questions? <a href="https://hartmann.example/faq">Read the FAQ</a> or reply to this mail.</p>
</div>
<p>On Tue, Oct 6, 2026 at 18:04, Mateo wrote:</p>
<blockquote type="cite"><p>Could we move the handover to Friday? Thursday doesn't work for me.</p></blockquote>`;

// A tiny inline image so the preview works without network.
const preview = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e8c9a8"/><stop offset="1" stop-color="#8a6f5a"/></linearGradient></defs><rect width="40" height="40" fill="url(#g)"/></svg>')}`;

export function ReadingDemo() {
	const [upload, setUpload] = useState(12);
	const [files, setFiles] = useState(["Handover-protocol-signed-final.pdf", "flat-photo.jpg", "floorplan.zip"]);
	useEffect(() => {
		const t = setInterval(() => setUpload((p) => (p >= 100 ? 12 : Math.min(100, p + 7))), 400);
		return () => clearInterval(t);
	}, []);

	return (
		<Thread subject="Keys for the new flat">
			<ThreadMessage
				from="Mateo Coerdts"
				email="mateo@nouvex.example"
				to={["Lena Hartmann"]}
				date={day(-3, 9, 12)}
				snippet="Hi Lena, when can I pick up the keys?"
			>
				<p>Hi Lena, when can I pick up the keys?</p>
			</ThreadMessage>
			<ThreadMessage
				from="Lena Hartmann"
				email="lena@hartmann.example"
				to={["Mateo Coerdts"]}
				date={day(-3, 11, 40)}
				snippet="Thursday evening would work for me."
			>
				<p>Thursday evening would work for me.</p>
			</ThreadMessage>
			<ThreadMessage
				from="Mateo Coerdts"
				email="mateo@nouvex.example"
				to={["Lena Hartmann"]}
				date={day(-2, 18, 4)}
				snippet="Could we move the handover to Friday?"
			>
				<p>Could we move the handover to Friday? Thursday doesn't work for me.</p>
			</ThreadMessage>
			<ThreadMessage
				from="Hartmann Immobilien"
				email="noreply@hartmann.example"
				to={["Mateo Coerdts"]}
				date={day(-1, 8, 30)}
				snippet="Your flat, ready on Friday"
				onReply={() => {}}
				onForward={() => {}}
			>
				<MailFrame html={newsletter} />
			</ThreadMessage>
			<ThreadMessage
				from="Lena Hartmann"
				email="lena@hartmann.example"
				to={["Mateo Coerdts", "Jonas Weber"]}
				date={day(0, 9, 42)}
				snippet="Here's the signed protocol and a photo."
				onReply={() => {}}
				onForward={() => {}}
			>
				<p>Here's the signed protocol and a photo. I'm still uploading the floor plan.</p>
				<AttachmentList>
					{files.map((name) => (
						<AttachmentTile
							key={name}
							name={name}
							size={name.endsWith(".pdf") ? 284_000 : name.endsWith(".jpg") ? 1_840_000 : 12_400_000}
							previewUrl={name.endsWith(".jpg") ? preview : undefined}
							progress={name.endsWith(".zip") ? upload : undefined}
							onOpen={() => {}}
							onRemove={() => setFiles((f) => f.filter((x) => x !== name))}
						/>
					))}
				</AttachmentList>
			</ThreadMessage>
		</Thread>
	);
}
