// SPDX-License-Identifier: Apache-2.0
import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import { cn } from "../lib";

const sizes = { sm: "size-6 text-xs", md: "size-8 text-sm", lg: "size-10 text-base" };

const initials = (name: string) =>
	name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0]?.toUpperCase())
		.join("");

export type AvatarProps = { src?: string; name: string; size?: keyof typeof sizes; className?: string };

export function Avatar({ src, name, size = "md", className }: AvatarProps) {
	return (
		<BaseAvatar.Root
			className={cn(
				"inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-selected font-medium text-muted select-none",
				sizes[size],
				className,
			)}
		>
			{src && <BaseAvatar.Image src={src} alt={name} className="size-full object-cover" />}
			<BaseAvatar.Fallback>{initials(name)}</BaseAvatar.Fallback>
		</BaseAvatar.Root>
	);
}
