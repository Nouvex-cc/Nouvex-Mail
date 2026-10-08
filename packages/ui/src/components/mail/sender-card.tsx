// SPDX-License-Identifier: Apache-2.0
import { PreviewCard } from "@base-ui/react/preview-card";
import { Check, Copy, Inbox, PenLine } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn, popup } from "../../lib";
import { Avatar } from "../avatar";
import { Button } from "../button";

export type SenderCardProps = {
	name: string;
	email: string;
	avatarUrl?: string;
	onWrite?(): void;
	onShowMessages?(): void;
	children: ReactNode;
};

/** Hovering a sender's name shows who it is: name, address to copy, and a way to write to them or see their mail. */
export function SenderCard({ name, email, avatarUrl, onWrite, onShowMessages, children }: SenderCardProps) {
	const [copied, setCopied] = useState(false);
	const copy = () => {
		navigator.clipboard.writeText(email).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};

	return (
		<PreviewCard.Root>
			<PreviewCard.Trigger delay={400} closeDelay={150} render={<span />} className="cursor-default">
				{children}
			</PreviewCard.Trigger>
			<PreviewCard.Portal>
				<PreviewCard.Positioner side="bottom" align="start" sideOffset={8} className="z-50">
					{/* Lives in a portal but React still bubbles its clicks to the row; they must not open the message. */}
					<PreviewCard.Popup
						className={cn(popup, "grid w-72 gap-3 rounded-xl p-3")}
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => e.stopPropagation()}
					>
						<div className="flex min-w-0 items-center gap-3">
							<Avatar src={avatarUrl} name={name} size="lg" />
							<div className="grid min-w-0 flex-1">
								<span className="truncate font-medium">{name}</span>
								<span className="truncate text-sm text-muted">{email}</span>
							</div>
							<Button
								size="icon-sm"
								variant="ghost"
								aria-label={copied ? "Copied" : "Copy address"}
								onClick={copy}
								className="rounded-full text-muted hover:text-ink"
							>
								{copied ? <Check strokeWidth={2} /> : <Copy strokeWidth={1.75} />}
							</Button>
						</div>
						{(onWrite || onShowMessages) && (
							<div className="flex gap-2">
								{onWrite && (
									<Button
										size="sm"
										variant="ghost"
										onClick={onWrite}
										className="h-8 flex-1 justify-center rounded-full bg-hover hover:bg-selected"
									>
										<PenLine strokeWidth={1.75} />
										Write
									</Button>
								)}
								{onShowMessages && (
									<Button
										size="sm"
										variant="ghost"
										onClick={onShowMessages}
										className="h-8 flex-1 justify-center rounded-full bg-hover hover:bg-selected"
									>
										<Inbox strokeWidth={1.75} />
										All messages
									</Button>
								)}
							</div>
						)}
					</PreviewCard.Popup>
				</PreviewCard.Positioner>
			</PreviewCard.Portal>
		</PreviewCard.Root>
	);
}
