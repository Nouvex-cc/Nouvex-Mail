// SPDX-License-Identifier: Apache-2.0
import { Meter as BaseMeter } from "@base-ui/react/meter";
import { Progress as BaseProgress } from "@base-ui/react/progress";
import { cn } from "../lib";

export type BarProps = { value: number | null; label?: string; className?: string };

export function Progress({ value, label, className }: BarProps) {
	return (
		<BaseProgress.Root value={value} className={cn("grid grid-cols-2 gap-y-1.5", className)}>
			{label && <BaseProgress.Label className="text-sm text-ink">{label}</BaseProgress.Label>}
			{label && <BaseProgress.Value className="text-right text-sm text-muted tabular-nums" />}
			<BaseProgress.Track className="col-span-2 h-1 overflow-hidden rounded-full bg-line">
				<BaseProgress.Indicator className="rounded-full bg-ink transition-all duration-300 ease-out" />
			</BaseProgress.Track>
		</BaseProgress.Root>
	);
}

export function Meter({ value, label, className }: BarProps & { value: number }) {
	return (
		<BaseMeter.Root value={value} className={cn("grid grid-cols-2 gap-y-1.5", className)}>
			{label && <BaseMeter.Label className="text-sm text-ink">{label}</BaseMeter.Label>}
			{label && <BaseMeter.Value className="text-right text-sm text-muted tabular-nums" />}
			<BaseMeter.Track className="col-span-2 h-1.5 overflow-hidden rounded-full bg-line">
				<BaseMeter.Indicator className="rounded-full bg-ink transition-all duration-300 ease-out" />
			</BaseMeter.Track>
		</BaseMeter.Root>
	);
}
