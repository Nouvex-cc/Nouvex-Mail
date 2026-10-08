// SPDX-License-Identifier: Apache-2.0
import { X } from "../../icons";
import { cn } from "../../lib";

export type LabelColor = "gray" | "red" | "orange" | "green" | "blue" | "purple";
export type MailLabel = { name: string; color: LabelColor };

// The tag shape mail apps use for labels (Material "label" icon, Apache-2.0), filled with the label's color.
export function LabelIcon({ color, className }: { color: LabelColor; className?: string }) {
	return (
		<svg
			aria-hidden
			viewBox="0 0 24 24"
			data-label-color={color}
			className={cn("label-icon size-4 shrink-0 fill-current", className)}
		>
			<path d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12z" />
		</svg>
	);
}

// A label on a message: tinted background, text in a darker shade of the same hue.
export function LabelChip({ name, color, onRemove }: MailLabel & { onRemove?(): void }) {
	return (
		<span
			data-label-color={color}
			className="label-chip inline-flex h-5 shrink-0 items-center gap-0.5 rounded-sm px-1.5 text-xs font-medium"
		>
			{name}
			{onRemove && (
				<button
					type="button"
					aria-label={`Remove ${name}`}
					onClick={onRemove}
					className="-mr-1 grid size-4 place-items-center rounded-sm opacity-70 hover:opacity-100"
				>
					<X strokeWidth={2} className="size-3" />
				</button>
			)}
		</span>
	);
}
