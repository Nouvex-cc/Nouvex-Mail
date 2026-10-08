// SPDX-License-Identifier: Apache-2.0
import { Toolbar as BaseToolbar } from "@base-ui/react/toolbar";
import { cn, type Styled } from "../lib";

const control =
	"inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-2 font-medium text-ink outline-none transition-colors duration-100 select-none hover:bg-hover checked:bg-selected disabled:text-faint [&_svg]:size-4 [&_svg]:shrink-0";

function Root({ className, ...props }: Styled<BaseToolbar.Root.Props>) {
	return <BaseToolbar.Root className={cn("flex items-center gap-0.5", className)} {...props} />;
}

function Button({ className, ...props }: Styled<BaseToolbar.Button.Props>) {
	return <BaseToolbar.Button className={cn(control, className)} {...props} />;
}

function Link({ className, ...props }: Styled<BaseToolbar.Link.Props>) {
	return <BaseToolbar.Link className={cn(control, "no-underline", className)} {...props} />;
}

function Group({ className, ...props }: Styled<BaseToolbar.Group.Props>) {
	return <BaseToolbar.Group className={cn("flex items-center gap-0.5", className)} {...props} />;
}

function Separator({ className, ...props }: Styled<BaseToolbar.Separator.Props>) {
	return <BaseToolbar.Separator className={cn("mx-1 h-4 w-px bg-line", className)} {...props} />;
}

export const Toolbar = { Root, Button, Link, Group, Separator };
