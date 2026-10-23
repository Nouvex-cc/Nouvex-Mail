// SPDX-License-Identifier: Apache-2.0
import { cn } from "../../lib";

export const labelColors = ["gray", "red", "orange", "green", "blue", "purple"] as const;
export type LabelColor = (typeof labelColors)[number];
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
export function LabelChip({ name, color }: MailLabel) {
	return (
		<span
			data-label-color={color}
			className="label-chip inline-flex h-5 shrink-0 items-center gap-0.5 rounded-sm px-1.5 text-xs font-medium"
		>
			{name}
		</span>
	);
}

// One of the label hues or none, e.g. for an account.
export function LabelColorPicker({
	value,
	onChange,
	label,
}: {
	value: LabelColor | null;
	onChange: (color: LabelColor | null) => void;
	label: string;
}) {
	const swatch =
		"size-6 rounded-full outline-offset-2 transition duration-150 ease-out hover:scale-110 focus-visible:outline-2 aria-pressed:outline-2 aria-pressed:outline-ink";
	return (
		<fieldset aria-label={label} className="m-0 flex min-w-0 items-center gap-2 border-0 p-0">
			<button
				type="button"
				aria-label="No color"
				aria-pressed={value === null}
				onClick={() => onChange(null)}
				className={cn(swatch, "border border-line-strong")}
			/>
			{labelColors.map((color) => (
				<button
					key={color}
					type="button"
					aria-label={color[0]?.toUpperCase() + color.slice(1)}
					aria-pressed={value === color}
					data-label-color={color}
					onClick={() => onChange(color)}
					className={cn(swatch, "label-icon bg-current")}
				/>
			))}
		</fieldset>
	);
}
