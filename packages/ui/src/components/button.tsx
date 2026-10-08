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
};

export function Button({ variant = "secondary", size = "md", className, ...props }: ButtonProps) {
	return (
		<BaseButton
			className={cn(
				"inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md font-medium transition duration-100 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
				variants[variant],
				sizes[size],
				className,
			)}
			{...props}
		/>
	);
}
