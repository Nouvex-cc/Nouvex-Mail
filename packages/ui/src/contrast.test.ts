// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { fitStrength, type Rgb, ratio } from "./contrast";

const white: Rgb = [255, 255, 255];
const black: Rgb = [0, 0, 0];
const grey: Rgb = [110, 110, 110];

test("contrast ratio", () => {
	expect(ratio(white, black)).toBeCloseTo(21, 5);
	expect(ratio(grey, white)).toBeCloseTo(ratio(white, grey), 5);
});

test("an image only shows as far as text over it stays readable", () => {
	// Grey text reads on white (5.3:1); a black image under it may only come through a little.
	const s = fitStrength([black, black, white], white, grey, 1);
	expect(s).toBeGreaterThan(0);
	expect(s).toBeLessThan(0.2);
	expect(ratio(grey, black.map((c, i) => s * c + (1 - s) * (white[i] ?? 0)) as Rgb)).toBeGreaterThanOrEqual(4.5);
	// A white image changes nothing.
	expect(fitStrength([white], white, grey, 0.8)).toBe(0.8);
	// When the text can't read on the paper itself, nothing of the image shows.
	expect(fitStrength([white], white, [200, 200, 200], 0.8)).toBe(0);
});
