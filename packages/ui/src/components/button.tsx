// SPDX-License-Identifier: Apache-2.0
import { Button as BaseButton } from "@base-ui/react/button";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { cn, type Styled } from "../lib";
import { TextMorph } from "./text-morph";

const variants = {
	primary: "bg-ink text-on-ink hover:opacity-90",
	secondary: "border border-line-strong bg-paper hover:bg-hover",
	ghost: "hover:bg-hover",
	danger: "bg-danger text-on-ink hover:opacity-90",
};

const sizes = {
	sm: "h-7 px-2.5 text-sm",
	md: "h-8 px-3",
	icon: "size-8 justify-center",
	"icon-sm": "size-7 justify-center",
};

export type ButtonProps = Styled<BaseButton.Props> & {
	variant?: keyof typeof variants;
	size?: keyof typeof sizes;
	loading?: boolean;
	/** Confirms the action: the button turns green and its label morphs into this text, e.g. "Saved". */
	success?: string | false;
};

// Returns the last active value and keeps it around for `ms` after it goes away, so exit transitions can play.
function usePresence<T>(value: T | false | undefined, ms: number) {
	const [shown, setShown] = useState(value);
	useEffect(() => {
		if (value) {
			setShown(value);
			return;
		}
		const t = setTimeout(() => setShown(value), ms);
		return () => clearTimeout(t);
	}, [value, ms]);
	return value || shown;
}

export function Button({
	variant = "secondary",
	size = "md",
	loading = false,
	success,
	className,
	children,
	onClick,
	...props
}: ButtonProps) {
	const ring = usePresence(loading, 200);

	return (
		<>
			<BaseButton
				className={cn(
					"relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md font-medium transition duration-200 disabled:pointer-events-none disabled:opacity-50 data-[success]:border-positive data-[success]:bg-positive data-[success]:text-on-ink data-[success]:opacity-100 [&>svg]:size-4 [&>svg]:shrink-0",
					variants[variant],
					sizes[size],
					className,
				)}
				aria-busy={loading || undefined}
				data-success={success ? "" : undefined}
				// Stays focusable while busy, but a second click must not submit twice.
				onClick={loading ? (e) => e.preventDefault() : onClick}
				{...props}
			>
				{typeof children === "string" ? (
					// The invisible copy keeps the button at its original size; the visible label morphs on top of it.
					<span className="relative inline-flex">
						<span aria-hidden className="invisible">
							{children}
						</span>
						<span className="absolute inset-0 flex items-center justify-center">
							<TextMorph icon={success ? <Check strokeWidth={2.25} className="size-4" /> : undefined}>
								{success || children}
							</TextMorph>
						</span>
					</span>
				) : (
					children
				)}
				{ring && (
					<>
						<span data-active={loading || undefined} className="button-scrim absolute inset-0 rounded-md bg-scrim" />
						<span aria-hidden className="pointer-events-none absolute -inset-1">
							<svg aria-hidden data-active={loading || undefined} className="button-ring size-full overflow-visible">
								<rect pathLength={100} />
							</svg>
						</span>
					</>
				)}
			</BaseButton>
			<span role="status" className="sr-only">
				{success || ""}
			</span>
		</>
	);
}
