// SPDX-License-Identifier: Apache-2.0
export { cn } from "cn";

// Base UI allows className as a function of state. Our components take plain strings only.
export type Styled<P> = Omit<P, "className"> & { className?: string };

// Shared looks so every floating surface and list item behaves the same.
export const popup =
	"origin-(--transform-origin) rounded-lg border border-line bg-raised text-ink shadow-pop outline-none transition duration-150 ease-out starting:scale-98 starting:opacity-0 ending:scale-98 ending:opacity-0 ending:duration-100";
// List items get their hover/focus background from <Highlight>, which slides between them.
export const item =
	"relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 outline-none disabled:text-faint [&_svg]:size-4 [&_svg]:shrink-0";
export const label = "px-2 py-1 text-xs font-medium text-muted";
export const field =
	"h-8 w-full rounded-md border border-line-strong bg-paper px-2.5 text-base text-ink outline-none placeholder:text-faint focus-visible:border-ink focus-visible:outline-0 invalid:border-danger invalid:focus-visible:border-danger disabled:opacity-50";
