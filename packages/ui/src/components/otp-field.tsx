// SPDX-License-Identifier: Apache-2.0
import { OTPField as BaseOTPField } from "@base-ui/react/otp-field";
import { cn, type Styled } from "../lib";

export function OTPField({
	className,
	length = 6,
	...props
}: Omit<Styled<BaseOTPField.Root.Props>, "length"> & { length?: number }) {
	return (
		<BaseOTPField.Root length={length} className={cn("flex gap-2", className)} {...props}>
			{Array.from({ length }, (_, i) => (
				<BaseOTPField.Input
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed number of slots
					key={i}
					aria-label={i === 0 ? undefined : `Character ${i + 1} of ${length}`}
					className="size-10 rounded-md border border-line-strong bg-paper text-center text-xl font-medium tabular-nums outline-none transition-colors duration-150 data-filled:border-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink/30 invalid:border-danger"
				/>
			))}
		</BaseOTPField.Root>
	);
}
