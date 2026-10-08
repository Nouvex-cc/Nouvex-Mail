// SPDX-License-Identifier: Apache-2.0
import { Field as BaseField } from "@base-ui/react/field";
import { cn, field, type Styled } from "../lib";
import { useCaret } from "./caret";

function FieldControl({ className, ref, ...props }: Styled<BaseField.Control.Props>) {
	const caret = useCaret<HTMLInputElement>(ref);
	return caret.wrap(
		<BaseField.Control ref={caret.ref} className={cn(field, caret.caretClass)} {...props} />,
		className,
	);
}

export const Field = {
	Root: ({ className, ...props }: Styled<BaseField.Root.Props>) => (
		<BaseField.Root className={cn("grid gap-1.5", className)} {...props} />
	),
	Label: ({ className, ...props }: Styled<BaseField.Label.Props>) => (
		<BaseField.Label className={cn("text-sm font-medium", className)} {...props} />
	),
	Control: FieldControl,
	Description: ({ className, ...props }: Styled<BaseField.Description.Props>) => (
		<BaseField.Description className={cn("text-sm text-muted", className)} {...props} />
	),
	Error: ({ className, ...props }: Styled<BaseField.Error.Props>) => (
		<BaseField.Error className={cn("text-sm text-danger", className)} {...props} />
	),
};
