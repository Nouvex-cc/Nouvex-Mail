// SPDX-License-Identifier: Apache-2.0
import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import { cn } from "../lib";
import type { LabelColor } from "./mail/label";

const sizes = { sm: "size-6 text-xs", md: "size-8 text-sm", lg: "size-10 text-base" };

const initials = (name: string) =>
	name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0]?.toUpperCase())
		.join("");

// Every name keeps one hue, for themes that color people (see avatar-tone in styles.css).
const hues = ["red", "orange", "green", "blue", "purple"];
const hue = (name: string) => hues[[...name].reduce((n, c) => n + (c.codePointAt(0) ?? 0), 0) % hues.length];

export type AvatarProps = {
	src?: string;
	name: string;
	size?: keyof typeof sizes;
	/** Always shown, unlike the hue a theme can give every name. */
	color?: LabelColor;
	className?: string;
};

export function Avatar({ src, name, size = "md", color, className }: AvatarProps) {
	return (
		<BaseAvatar.Root
			data-label-color={color ?? hue(name)}
			data-colored={color ? "" : undefined}
			className={cn(
				"avatar-tone inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-selected font-medium text-muted select-none",
				sizes[size],
				className,
			)}
		>
			{src && (
				<BaseAvatar.Image
					src={src}
					alt={name}
					className="size-full object-cover transition-opacity duration-200 starting:opacity-0"
				/>
			)}
			<BaseAvatar.Fallback>{initials(name)}</BaseAvatar.Fallback>
		</BaseAvatar.Root>
	);
}
