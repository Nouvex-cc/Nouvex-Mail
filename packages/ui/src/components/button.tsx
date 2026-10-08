// SPDX-License-Identifier: Apache-2.0
import { Button as BaseButton } from "@base-ui/react/button";
import { cn, type Styled } from "../lib";

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
};

export function Button({
	variant = "secondary",
	size = "md",
	loading = false,
	className,
	children,
	onClick,
	...props
}: ButtonProps) {
	return (
		<BaseButton
			className={cn(
				"relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md font-medium transition duration-100 disabled:pointer-events-none disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0",
				variants[variant],
				sizes[size],
				className,
			)}
			aria-busy={loading || undefined}
			data-loading={loading || undefined}
			// Stays focusable while loading, but a second click must not submit twice.
			onClick={loading ? (e) => e.preventDefault() : onClick}
			{...props}
		>
			{children}
			{loading && (
				<>
					<span className="absolute inset-0 rounded-md bg-scrim" />
					<span aria-hidden className="pointer-events-none absolute -inset-1">
						<svg className="button-ring size-full overflow-visible">
							<rect pathLength={100} />
						</svg>
					</span>
				</>
			)}
		</BaseButton>
	);
}
