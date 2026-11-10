// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { type Rgb, ratio } from "./contrast";
import { background, lch, picture, rgb, text } from "./mail-dark";

const surface: Rgb = [18, 16, 14];
const ink: Rgb = [237, 235, 232];
const near = (a: Rgb, b: Rgb, by = 2) => a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= by);

test("colors survive the trip through OKLCH", () => {
	for (const c of [
		[18, 16, 14],
		[255, 255, 255],
		[26, 115, 232],
		[200, 30, 30],
	] as Rgb[])
		expect(near(rgb(lch(c)), c)).toBe(true);
});

test("the mail's paper and its dark panels become exactly the surface", () => {
	expect(background([255, 255, 255], 0.1, surface)).toEqual(surface);
	expect(background([244, 244, 244], 1, surface)).toEqual(surface);
	expect(background([0, 0, 0], 0.2, surface)).toEqual(surface);
	expect(background([18, 18, 18], 1, surface)).toEqual(surface);
	expect(background([10, 26, 58], 0.3, surface)).toEqual(surface);
});

test("what should stand out still does", () => {
	expect(background([0, 0, 0], 0.005, surface)).not.toEqual(surface);
	expect(background([244, 244, 244], 0.05, surface)).not.toEqual(surface);
	expect(background([26, 115, 232], 0.005, surface)).toEqual([26, 115, 232]);
	const tint = lch(background([232, 240, 254], 0.05, surface));
	expect(tint.l).toBeLessThan(0.3);
	expect(tint.c).toBeGreaterThan(0.01);
});

test("text reads on what's under it and keeps its rank", () => {
	const panels: Rgb[] = [
		surface,
		background([244, 244, 244], 0.05, surface),
		background([232, 240, 254], 0.05, surface),
	];
	for (const on of panels)
		for (const c of [
			[0, 0, 0],
			[102, 102, 102],
			[26, 115, 232],
			[180, 20, 20],
			[153, 153, 153],
		] as Rgb[])
			expect(ratio(text(c, on, ink), on)).toBeGreaterThanOrEqual(4.5);
	expect(text([255, 255, 255], [26, 115, 232], ink)).toEqual([255, 255, 255]);
	expect(lch(text([0, 0, 0], surface, ink)).l).toBeGreaterThan(lch(text([102, 102, 102], surface, ink)).l);
});

const fill = (c: [number, number, number, number], n = 4) => Array.from({ length: n * n }, () => c).flat();

test("pictures: dark ink on nothing flips, a drawing on white blends, photos stay", () => {
	const ink = fill([0, 0, 0, 0]);
	ink.splice(20, 16, ...fill([20, 20, 20, 255], 2));
	expect(picture(ink, 4)).toBe("flip");
	const logo = fill([255, 255, 255, 255]);
	logo.splice(20, 8, 30, 30, 30, 255, 30, 30, 30, 255);
	expect(picture(logo, 4)).toBe("blend");
	expect(picture(fill([120, 90, 60, 255]), 4)).toBe(null);
	expect(picture(fill([0, 0, 0, 0]), 4)).toBe(null);
});
