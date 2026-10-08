// SPDX-License-Identifier: Apache-2.0
import { Field as BaseField } from "@base-ui/react/field";
import { Fieldset as BaseFieldset } from "@base-ui/react/fieldset";
import { Form as BaseForm } from "@base-ui/react/form";
import { cn, field, type Styled } from "../lib";

export const Field = {
	Root: ({ className, ...props }: Styled<BaseField.Root.Props>) => (
		<BaseField.Root className={cn("grid gap-1.5", className)} {...props} />
	),
	Label: ({ className, ...props }: Styled<BaseField.Label.Props>) => (
		<BaseField.Label className={cn("text-sm font-medium", className)} {...props} />
	),
	Control: ({ className, ...props }: Styled<BaseField.Control.Props>) => (
		<BaseField.Control className={cn(field, className)} {...props} />
	),
	Description: ({ className, ...props }: Styled<BaseField.Description.Props>) => (
		<BaseField.Description className={cn("text-sm text-muted", className)} {...props} />
	),
	Error: ({ className, ...props }: Styled<BaseField.Error.Props>) => (
		<BaseField.Error className={cn("text-sm text-danger", className)} {...props} />
	),
};

export const Fieldset = {
	Root: ({ className, ...props }: Styled<BaseFieldset.Root.Props>) => (
		<BaseFieldset.Root className={cn("grid gap-4", className)} {...props} />
	),
	Legend: ({ className, ...props }: Styled<BaseFieldset.Legend.Props>) => (
		<BaseFieldset.Legend className={cn("text-lg font-semibold", className)} {...props} />
	),
};

export function Form({ className, ...props }: Styled<BaseForm.Props>) {
	return <BaseForm className={cn("grid gap-4", className)} {...props} />;
}
