// SPDX-License-Identifier: Apache-2.0

export type Rgb = [number, number, number];

const linear = (c: number) => {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** Relative luminance (WCAG 2). */
const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** Contrast ratio between two colors, 1 to 21. */
export function ratio(a: Rgb, b: Rgb) {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * How strongly an image may show through a veil of paper (opacity of the image over it) so that text still reads
 * against nearly all of it: the share `spare` of the darkest/brightest spots may fall short. `pixels` is the image as
 * it will be seen, already blurred.
 */
export function fitStrength(pixels: Rgb[], paper: Rgb, text: Rgb, max: number, need = 4.5, spare = 0.05) {
	const reads = (s: number) => {
		const ratios = pixels
			.map((p) => ratio(text, p.map((c, i) => s * c + (1 - s) * (paper[i] ?? 0)) as Rgb))
			.sort((x, y) => x - y);
		return (ratios[Math.floor(ratios.length * spare)] ?? 21) >= need;
	};
	if (!pixels.length || reads(max)) return max;
	let lo = 0;
	let hi = max;
	for (let i = 0; i < 12; i++) {
		const mid = (lo + hi) / 2;
		if (reads(mid)) lo = mid;
		else hi = mid;
	}
	return lo;
}
