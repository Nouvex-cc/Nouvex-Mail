// SPDX-License-Identifier: Apache-2.0
import { Button as BaseButton } from "@base-ui/react/button";
import { Check } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { cn, type Styled } from "../lib";
import { TextMorph } from "./text-morph";

const variants = {
	primary: "bg-ink text-on-ink hover:opacity-90",
	secondary: "border border-line-strong bg-paper hover:bg-hover",
	ghost: "hover:bg-hover",
	danger: "bg-danger text-on-ink hover:opacity-90",
};

// Lets the morphing label use the button's padding, so letters leave through the button's edge, not past it.
const labelArea = { sm: "-inset-x-2.5", md: "-inset-x-3", icon: "inset-x-0", "icon-sm": "inset-x-0" };

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
	/** Milliseconds; the outline drains over this time, e.g. while "Undo" is still possible. */
	countdown?: number;
	/** Every other label this button can morph into ("Undo", "Sent"). It sizes to the widest, so it never resizes. */
	labels?: string[];
	/** Milliseconds the button has to be held; it fills up meanwhile and calls `onHoldComplete` when full. */
	hold?: number;
	onHoldComplete?: () => void;
	/** Shown briefly when a hold button is only tapped, e.g. "Hold to delete". */
	holdHint?: string;
	/** Crossfade label changes instead of morphing letters. */
	fade?: boolean;
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

// Press-and-hold: fills `fill` over `ms`, calls `done` when full, runs back when let go early.
function useHold(ms: number | undefined, done: (() => void) | undefined, hint: string | undefined) {
	const fill = useRef<HTMLSpanElement>(null);
	const run = useRef<Animation | null>(null);
	const pressedAt = useRef(0);
	const [hinting, setHinting] = useState(false);
	useEffect(() => {
		if (!hinting) return;
		const t = setTimeout(() => setHinting(false), 1600);
		return () => clearTimeout(t);
	}, [hinting]);

	const start = () => {
		const el = fill.current;
		if (!ms || !el || run.current) return;
		for (const a of el.getAnimations()) a.cancel();
		pressedAt.current = performance.now();
		setHinting(false);
		const a = el.animate({ scale: ["0 1", "1 1"] }, { duration: ms, fill: "forwards" });
		run.current = a;
		a.onfinish = () => {
			run.current = null;
			el.animate({ opacity: [1, 0] }, { duration: 200, fill: "forwards" });
			done?.();
		};
	};

	const stop = () => {
		const a = run.current;
		const el = fill.current;
		if (!a || !el || !ms) return;
		const progress = Number(a.currentTime ?? 0) / ms;
		a.cancel();
		run.current = null;
		el.animate({ scale: [`${progress} 1`, "0 1"] }, { duration: 200, easing: "ease-out" });
		if (hint && performance.now() - pressedAt.current < 250) setHinting(true);
	};

	const key = (e: KeyboardEvent, down: boolean) => {
		if (e.key !== " " && e.key !== "Enter") return;
		e.preventDefault();
		if (down && !e.repeat) start();
		if (!down) stop();
	};

	const handlers = ms
		? {
				onPointerDown: (e: { button: number }) => e.button === 0 && start(),
				onPointerUp: stop,
				onPointerLeave: stop,
				onPointerCancel: stop,
				onKeyDown: (e: KeyboardEvent) => key(e, true),
				onKeyUp: (e: KeyboardEvent) => key(e, false),
				onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
			}
		: {};
	return { fill, handlers, hinting };
}

export function Button({
	variant = "secondary",
	size = "md",
	loading = false,
	success,
	countdown,
	labels = [],
	hold,
	onHoldComplete,
	holdHint,
	fade,
	className,
	children,
	onClick,
	...props
}: ButtonProps) {
	const ring = usePresence(loading, 200);
	const { fill, handlers, hinting } = useHold(hold, onHoldComplete, holdHint);
	const holdHelp = useId();
	const timer = usePresence(countdown, 160);
	const drain = useRef<SVGRectElement>(null);
	useEffect(() => {
		if (countdown)
			drain.current?.animate({ strokeDasharray: ["100 0", "0 100"] }, { duration: countdown, fill: "forwards" });
	}, [countdown]);

	// Temporary labels ("Undo", "Saved") must not resize the button, so the size follows the last resting label.
	const resting = useRef(children);
	if (!loading && !success && !countdown) resting.current = children;

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
				aria-describedby={hold ? holdHelp : undefined}
				{...props}
				{...handlers}
			>
				{hold && (
					<span
						ref={fill}
						aria-hidden
						className="pointer-events-none absolute inset-0 origin-left scale-x-0 rounded-md bg-hold"
					/>
				)}
				{typeof children === "string" ? (
					// Invisible copies of every label, stacked, give the button its size; the visible label morphs on top.
					// Extra labels reserve room for the check that success shows in front of them.
					<span className="relative inline-flex">
						<span aria-hidden className="invisible inline-grid">
							<span className="col-start-1 row-start-1">{resting.current}</span>
							{labels.map((label) => (
								<span key={label} className="col-start-1 row-start-1 flex">
									<span className="w-5.5 shrink-0" />
									{label}
								</span>
							))}
							{holdHint && <span className="col-start-1 row-start-1">{holdHint}</span>}
						</span>
						<span
							className={cn("absolute inset-y-0 flex items-center justify-center overflow-hidden", labelArea[size])}
						>
							<TextMorph
								by={fade ? "text" : "letter"}
								icon={success ? <Check strokeWidth={2.25} className="size-4" /> : undefined}
							>
								{success || (hinting && holdHint) || children}
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
							<svg
								aria-hidden
								data-active={loading || undefined}
								className="button-outline button-ring size-full overflow-visible"
							>
								<rect pathLength={100} />
							</svg>
						</span>
					</>
				)}
				{timer && (
					<span aria-hidden className="pointer-events-none absolute -inset-1">
						<svg
							aria-hidden
							data-active={countdown ? "" : undefined}
							className="button-outline button-countdown size-full overflow-visible"
						>
							<rect ref={drain} pathLength={100} />
						</svg>
					</span>
				)}
			</BaseButton>
			<span role="status" className="sr-only">
				{success || ""}
			</span>
			{hold && (
				<span id={holdHelp} className="sr-only">
					Press and hold
				</span>
			)}
		</>
	);
}
