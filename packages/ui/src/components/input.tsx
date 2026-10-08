// SPDX-License-Identifier: Apache-2.0
import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps } from "react";
import { cn, field, type Styled } from "../lib";
import { useCaret } from "./caret";

export function Input({ className, ref, ...props }: Styled<BaseInput.Props>) {
	const caret = useCaret<HTMLInputElement>(ref);
	return caret.wrap(<BaseInput ref={caret.ref} className={cn(field, caret.caretClass)} {...props} />, className);
}

export function Textarea({ className, ref, ...props }: ComponentProps<"textarea">) {
	const caret = useCaret<HTMLTextAreaElement>(ref);
	return caret.wrap(
		<textarea ref={caret.ref} className={cn(field, "h-auto min-h-20 resize-y py-2", caret.caretClass)} {...props} />,
		className,
	);
}
