// SPDX-License-Identifier: Apache-2.0
import { Slider as BaseSlider } from "@base-ui/react/slider";
import { cn, type Styled } from "../lib";

export type SliderProps = Styled<BaseSlider.Root.Props> & {
	label?: string;
	/** Shows the current value next to the label. */
	showValue?: boolean;
};

// The thumb is an upright rounded bar, not a circle; it grows a little while hovered or dragged.
export function Slider({ label, showValue = false, className, ...props }: SliderProps) {
	const initial = props.value ?? props.defaultValue;
	const thumbs = Array.isArray(initial) ? initial.length : 1;
	return (
		<BaseSlider.Root className={cn("grid w-full gap-1.5", className)} {...props}>
			{(label || showValue) && (
				<div className="flex items-baseline justify-between text-sm">
					{label && <BaseSlider.Label className="font-medium">{label}</BaseSlider.Label>}
					{showValue && <BaseSlider.Value className="text-muted tabular-nums" />}
				</div>
			)}
			<BaseSlider.Control
				// Jumps (a click further along, arrow keys) glide; once the pointer moves while pressed, the thumb follows
				// it directly without easing.
				onPointerMove={(e) => {
					if (e.buttons) e.currentTarget.dataset.moving = "";
				}}
				onPointerUp={(e) => delete e.currentTarget.dataset.moving}
				onPointerCancel={(e) => delete e.currentTarget.dataset.moving}
				className="group flex h-6 w-full cursor-pointer touch-none items-center select-none data-disabled:cursor-default data-disabled:opacity-50"
			>
				<BaseSlider.Track className="relative h-1 w-full rounded-full bg-line-strong">
					<BaseSlider.Indicator className="slider-glide rounded-full bg-ink" />
					{Array.from({ length: thumbs }, (_, i) => (
						<BaseSlider.Thumb
							// biome-ignore lint/suspicious/noArrayIndexKey: one thumb per value, fixed count
							key={i}
							index={thumbs > 1 ? i : undefined}
							className="slider-glide h-4 w-1 rounded-full bg-ink outline-none ring-2 ring-paper group-hover:scale-x-150 group-hover:scale-y-125 focus-visible:outline-2 focus-visible:outline-offset-2 data-dragging:scale-x-150 data-dragging:scale-y-125"
						/>
					))}
				</BaseSlider.Track>
			</BaseSlider.Control>
		</BaseSlider.Root>
	);
}
