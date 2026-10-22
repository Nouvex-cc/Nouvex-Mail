// SPDX-License-Identifier: AGPL-3.0-only
// Writes the palette from packages/ui/src/styles.css into the asset catalog as color sets with a light and a dark
// value, so SwiftUI gets them as Color.paper, Color.ink and so on. Run: bun apps/apple/tokens.ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const css = readFileSync(new URL("../../packages/ui/src/styles.css", import.meta.url), "utf8");
const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
const out = new URL("Nouvex/Assets.xcassets/Tokens/", import.meta.url);
const names = ["paper", "sunken", "raised", "ink", "on-ink", "muted", "faint", "line", "line-strong", "hover", "selected", "danger", "positive"];

const color = (oklch: string) => {
	const [l, c, h, alpha = "1"] = oklch.replace("/", " ").split(/\s+/).filter(Boolean);
	// Bun.color takes the lightness only as a percentage.
	const rgb = Bun.color(`oklch(${Number(l) * 100}% ${c} ${h})`, "{rgb}");
	if (!rgb) throw new Error(`can't read oklch(${oklch})`);
	const part = (v: number) => (v / 255).toFixed(3);
	return { "color-space": "srgb", components: { red: part(rgb.r), green: part(rgb.g), blue: part(rgb.b), alpha: Number(alpha).toFixed(3) } };
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(new URL("Contents.json", out), JSON.stringify({ info: { author: "xcode", version: 1 }, properties: { "provides-namespace": false } }, null, 2));
for (const name of names) {
	const match = root.match(new RegExp(`--${name}: light-dark\\(oklch\\(([^)]+)\\), oklch\\(([^)]+)\\)\\)`));
	if (!match) throw new Error(`--${name} not found in styles.css`);
	const dir = new URL(`${name}.colorset/`, out);
	mkdirSync(dir);
	const colors = [
		{ idiom: "universal", color: color(match[1]) },
		{ idiom: "universal", appearances: [{ appearance: "luminosity", value: "dark" }], color: color(match[2]) },
	];
	writeFileSync(new URL("Contents.json", dir), `${JSON.stringify({ colors, info: { author: "xcode", version: 1 } }, null, 2)}\n`);
}
