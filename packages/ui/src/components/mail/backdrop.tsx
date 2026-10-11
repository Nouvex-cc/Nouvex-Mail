// SPDX-License-Identifier: Apache-2.0

export type BackdropProps = {
	/** Any image URL, e.g. a data URL the user picked. */
	src: string;
	/** Blur radius in pixels. */
	blur: number;
	/** Film grain, 0 to 1. */
	grain: number;
	/** How much of the image shows through the paper, 0 to 1; text stays readable on lower values. */
	strength: number;
};

/** An image behind the content panel (AppShell's backdrop), blurred, veiled with paper and with grain on top. */
export function Backdrop({ src, blur, grain, strength }: BackdropProps) {
	return (
		<div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden bg-paper">
			<img
				src={src}
				alt=""
				// Scaled a little past the edges so the blur doesn't fade them into the paper.
				className="size-full object-cover"
				style={{
					filter: blur ? `blur(${blur}px)` : undefined,
					scale: blur ? 1 + blur / 150 : undefined,
					opacity: strength,
				}}
			/>
			<div className="grain absolute inset-0" style={{ opacity: grain }} />
		</div>
	);
}
