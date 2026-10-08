// SPDX-License-Identifier: Apache-2.0
import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps } from "react";
import { cn, field, type Styled } from "../lib";

export function Input({ className, ...props }: Styled<BaseInput.Props>) {
	return <BaseInput className={cn(field, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
	return <textarea className={cn(field, "h-auto min-h-20 resize-y py-2", className)} {...props} />;
}
