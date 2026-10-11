// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { fitStrength, type Rgb } from "../../contrast";
import { useDark } from "../../dark";

export type BackdropProps = {
	/** Any image URL, e.g. a data URL the user picked. */
	src: string;
	/** Blur radius in pixels. */
	blur: number;
	/** Film grain, 0 to 1. */
	grain: number;
	/** How much of the image shows through the paper, 0 to 1. Capped so text over it stays readable. */
	strength: number;
	/** Reports how much of it shows after that cap. */
	onFit?(strength: number): void;
};

type Scheme = "light" | "dark";

// The image as it will be seen behind the text: small and blurred, which is close enough per spot.
async function sample(src: string, blur: number): Promise<Rgb[]> {
	const img = new Image();
	img.src = src;
	await img.decode();
	const canvas = document.createElement("canvas");
	canvas.width = 64;
	canvas.height = Math.max(1, Math.round((64 * img.height) / img.width));
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return [];
	ctx.filter = `blur(${(blur * 64) / 1200}px)`;
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
	const pixels: Rgb[] = [];
	for (let i = 0; i < data.length; i += 4) pixels.push([data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0]);
	return pixels;
}

// A CSS color as sRGB, through a 1×1 canvas, so oklch and light-dark() come out as the browser draws them.
function rgb(color: string): Rgb {
	const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
	if (!ctx) return [0, 0, 0];
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, 1, 1);
	const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
	return [r, g, b];
}

/**
 * An image behind the content panel (AppShell's backdrop), blurred, veiled with paper and with grain on top. It
 * keeps text readable on its own: it measures the image, picks dark or light text for the panel, whichever lets
 * more of it through, and shows only as much of it as the secondary text can stand (4.5:1 with a margin, on all but its 2% worst
 * spots). The panel follows the pick through data-backdrop (see backdrop-host in styles.css).
 */
export function Backdrop({ src, blur, grain, strength, onFit }: BackdropProps) {
	const dark = useDark();
	const probes = useRef<Record<Scheme, HTMLSpanElement | null>>({ light: null, dark: null });
	const [pixels, setPixels] = useState<Rgb[]>();
	const [fit, setFit] = useState<{ scheme: Scheme; strength: number }>();

	useEffect(() => {
		let live = true;
		sample(src, blur)
			.then((p) => live && setPixels(p))
			.catch(() => live && setPixels([]));
		return () => {
			live = false;
		};
	}, [src, blur]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the theme changes the token colors the probes show
	useEffect(() => {
		if (!pixels) return;
		const own: Scheme = dark ? "dark" : "light";
		const fits = (["light", "dark"] as const).map((scheme) => {
			const probe = probes.current[scheme];
			if (!probe) return { scheme, strength: 0 };
			const style = getComputedStyle(probe);
			return {
				scheme,
				strength: fitStrength(pixels, rgb(style.backgroundColor), rgb(style.color), strength, 4.8 + grain, 0.02),
			};
		});
		// The app's own scheme unless the other lets clearly more of the image through.
		const mine = fits.find((f) => f.scheme === own) ?? fits[0];
		const other = fits.find((f) => f.scheme !== own) ?? fits[0];
		const best = other && mine && other.strength > mine.strength + 0.1 ? other : mine;
		if (best) {
			setFit(best);
			onFit?.(best.strength);
		}
	}, [pixels, strength, grain, dark]);

	return (
		<div
			aria-hidden
			data-backdrop={fit?.scheme ?? "measuring"}
			className="pointer-events-none absolute inset-0 overflow-hidden bg-paper"
		>
			<img
				src={src}
				alt=""
				// Scaled a little past the edges so the blur doesn't fade them into the paper.
				className="size-full object-cover transition-opacity duration-200"
				style={{
					filter: blur ? `blur(${blur}px)` : undefined,
					scale: blur ? 1 + blur / 150 : undefined,
					opacity: fit?.strength ?? 0,
				}}
			/>
			<div className="grain absolute inset-0" style={{ opacity: grain }} />
			{(["light", "dark"] as const).map((scheme) => (
				<span
					key={scheme}
					ref={(el) => {
						probes.current[scheme] = el;
					}}
					className="invisible absolute bg-paper text-muted"
					style={{ colorScheme: scheme }}
				/>
			))}
		</div>
	);
}
