// SPDX-License-Identifier: Apache-2.0
// Turns a mail dark by giving every element new colors, the way the app's own surfaces are built, instead of inverting
// the page: what was the mail's paper becomes exactly the surface the mail sits on, so it has no edge against the app.
// The web and the Apple apps (MailDark.js, `bun run --cwd packages/ui dark`) run this same code.
import { type Rgb, ratio } from "./contrast";

type Lch = { l: number; c: number; h: number };

const toLinear = (c: number) => {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toByte = (v: number) => {
	const c = Math.min(1, Math.max(0, v));
	return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
};

/** sRGB to OKLCH. */
export function lch([red, green, blue]: Rgb): Lch {
	const [r, g, b] = [toLinear(red), toLinear(green), toLinear(blue)];
	const m = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const n = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const a = 1.9779984951 * m - 2.428592205 * n + 0.4505937099 * s;
	const z = 0.0259040371 * m + 0.7827717662 * n - 0.808675766 * s;
	return { l: 0.2104542553 * m + 0.793617785 * n - 0.0040720468 * s, c: Math.hypot(a, z), h: Math.atan2(z, a) };
}

/** OKLCH to sRGB, clipped to what it can show. */
export function rgb({ l, c, h }: Lch): Rgb {
	const [a, z] = [c * Math.cos(h), c * Math.sin(h)];
	const m = (l + 0.3963377774 * a + 0.2158037573 * z) ** 3;
	const n = (l - 0.1055613458 * a - 0.0638541728 * z) ** 3;
	const s = (l - 0.0894841775 * a - 1.291485548 * z) ** 3;
	return [
		toByte(4.0767416621 * m - 3.3077115913 * n + 0.2309699292 * s),
		toByte(-1.2684380046 * m + 2.6097574011 * n - 0.3413193965 * s),
		toByte(-0.0041960863 * m - 0.7034186147 * n + 1.707614701 * s),
	];
}

const grey = 0.035;

/** A background's dark color. `cover` is the share of the mail it takes up, which tells a panel from a button. */
export function background(color: Rgb, cover: number, surface: Rgb): Rgb {
	const { l, c, h } = lch(color);
	const s = lch(surface);
	const tone = (up: number, chroma = s.c, hue = s.h) => rgb({ l: s.l + up, c: chroma, h: hue });
	// Dark areas, the mail's own dark panels included, take on the surface too.
	if (l < 0.3 && cover >= 0.02) return surface;
	// A pale tint: all over it's the mail's paper, in a panel it stays a tint.
	if (l > 0.82 && c >= 0.018 && c < 0.08) return cover >= 0.3 ? surface : tone(0.06, Math.min(c * 1.4, 0.05), h);
	if (c < grey) {
		if (l >= 0.985) return surface;
		if (l >= 0.9) return cover >= 0.3 ? surface : tone(0.045);
		if (l >= 0.5) return tone(0.045 + (0.9 - l) * 0.35);
		return tone(0.1);
	}
	return cover >= 0.1 ? rgb({ l: Math.min(l, 0.42), c: c * 0.85, h }) : color;
}

/** A text color that reads on `on` (WCAG AA): dark greys become the app's ink in steps, colors keep their hue. */
export function text(color: Rgb, on: Rgb, ink: Rgb): Rgb {
	if (ratio(color, on) >= 4.5) return color;
	const { l, c, h } = lch(color);
	const i = lch(ink);
	const next = c < grey ? { l: i.l - Math.min(l, 0.6) * 0.35, c: i.c, h: i.h } : { l, c: Math.min(c, 0.16), h };
	const step = lch(on).l < 0.6 ? 0.02 : -0.02;
	while (next.l > 0 && next.l < 1 && ratio(rgb(next), on) < 4.5) next.l += step;
	return rgb(next);
}

/** A border: greys become the app's hairline, colors stay visible. */
export function line(color: Rgb, surface: Rgb): Rgb {
	const { l, c, h } = lch(color);
	const s = lch(surface);
	return c < grey ? rgb({ l: s.l + 0.085, c: s.c, h: s.h }) : rgb({ l: Math.min(0.7, Math.max(0.35, l)), c, h });
}

/**
 * What a picture needs on dark: "flip" for dark ink on transparency, which would vanish, "blend" for a drawing on a
 * white box, which would glare. Photos and anything else stay as sent. `data` is RGBA.
 */
export function picture(data: ArrayLike<number>, width: number) {
	const total = data.length / 4;
	const height = total / width;
	const pale = (i: number) => {
		const { l, c } = lch([data[i * 4] ?? 0, data[i * 4 + 1] ?? 0, data[i * 4 + 2] ?? 0]);
		return (data[i * 4 + 3] ?? 0) >= 16 && l > 0.94 && c < 0.03;
	};
	let clear = 0;
	let white = 0;
	let light = 0;
	let chroma = 0;
	for (let i = 0; i < total; i++) {
		if ((data[i * 4 + 3] ?? 0) < 16) {
			clear++;
			continue;
		}
		const { l, c } = lch([data[i * 4] ?? 0, data[i * 4 + 1] ?? 0, data[i * 4 + 2] ?? 0]);
		light += l;
		chroma += c;
		if (l > 0.94 && c < 0.03) white++;
	}
	const seen = total - clear;
	if (!seen) return null;
	if (clear / total > 0.15) return light / seen < 0.5 ? "flip" : null;
	const corners = [0, width - 1, total - width, total - 1];
	return height > 1 && corners.every(pale) && white / seen > 0.45 && chroma / seen < 0.06 ? "blend" : null;
}

const css = (c: Rgb) => `rgb(${c[0]} ${c[1]} ${c[2]})`;
const mix = (c: Rgb, a: number, under: Rgb) => c.map((v, i) => Math.round(v * a + (under[i] ?? 0) * (1 - a))) as Rgb;
// Mails that bring their own dark design say so in their CSS, and are written for a dark page.
const ownDark = /prefers-color-scheme\s*:\s*dark|color-scheme\s*:[^;"'}]*\bdark/i;
const sides = ["top", "right", "bottom", "left"];
const flip = "invert(1) hue-rotate(180deg)";

function parser(doc: Document) {
	const canvas = doc.createElement("canvas");
	canvas.width = canvas.height = 1;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	const known = new Map<string, [Rgb, number]>();
	const read = (value: string): [Rgb, number] => {
		const m = value.match(/^rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?\)$/);
		if (m) return [[Number(m[1]), Number(m[2]), Number(m[3])], m[4] === undefined ? 1 : Number(m[4])];
		// oklch(), color() and the like.
		if (!ctx) return [[0, 0, 0], 0];
		ctx.clearRect(0, 0, 1, 1);
		ctx.fillStyle = value;
		ctx.fillRect(0, 0, 1, 1);
		const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
		return [[r, g, b], a / 255];
	};
	return (value: string) => {
		const got = known.get(value) ?? read(value);
		known.set(value, got);
		return got;
	};
}

// Decided from a small copy of the picture. Remote ones come through our own proxy, so they can be read.
function settle(img: HTMLImageElement) {
	if (img.naturalWidth < 8 || img.naturalHeight < 8) return;
	const canvas = img.ownerDocument.createElement("canvas");
	canvas.width = canvas.height = 24;
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	try {
		ctx.drawImage(img, 0, 0, 24, 24);
		const look = picture(ctx.getImageData(0, 0, 24, 24).data, 24);
		if (look) img.style.setProperty("filter", flip, "important");
		if (look === "blend") img.style.setProperty("mix-blend-mode", "screen", "important");
	} catch {
		// A picture that can't be read stays as sent.
	}
}

/** Recolors a written mail for `surface`, the color of what it sits on, with `inkColor` as its text. */
export function darken(doc: Document, surfaceColor: string, inkColor: string) {
	const root = doc.documentElement;
	try {
		const parse = parser(doc);
		const surface = parse(surfaceColor)[0];
		const ink = parse(inkColor)[0];
		// Not our own <style data-nx>, which says dark too.
		const own = [...doc.querySelectorAll("style:not([data-nx])")].some((s) => ownDark.test(s.textContent ?? ""));
		const area = Math.max(1, root.scrollWidth * root.scrollHeight);
		const view = doc.defaultView;
		if (!view) return;

		// Reads first and writes after: a read following a write would lay the page out again for every element.
		const reads = [doc.body, ...doc.body.querySelectorAll<HTMLElement>("*")]
			.filter((el) => el.namespaceURI === root.namespaceURI && !["STYLE", "SCRIPT", "BR", "IMG"].includes(el.tagName))
			.map((el) => {
				const s = view.getComputedStyle(el);
				const box = el.getBoundingClientRect();
				return {
					el,
					back: s.backgroundColor,
					image: s.backgroundImage,
					color: s.color,
					cover: (box.width * box.height) / area,
					borders: sides.flatMap((side) =>
						s.getPropertyValue(`border-${side}-style`) !== "none" &&
						Number.parseFloat(s.getPropertyValue(`border-${side}-width`)) > 0
							? [{ side, color: s.getPropertyValue(`border-${side}-color`) }]
							: [],
					),
				};
			});

		type Under = { from: Rgb; to: Rgb; keep: boolean };
		const start: Under = { from: own ? surface : [255, 255, 255], to: surface, keep: false };
		const under = new Map<Element, Under>();
		const writes: [HTMLElement, string, string][] = [];
		for (const { el, back, image, color, cover, borders } of reads) {
			const parent = (el.parentElement && under.get(el.parentElement)) || start;
			let here = parent;
			const [fill, alpha] = parse(back);
			if (image.includes("url(")) here = { ...parent, keep: true };
			else if (image !== "none") {
				// A gradient: its stops change like any background, and the first one stands for it under text.
				let first: Under | undefined;
				const stops = image.replace(/rgba?\([^)]*\)/g, (stop) => {
					const [c, a] = parse(stop);
					const from = mix(c, a, parent.from);
					const to = background(from, cover, surface);
					first ??= { from, to, keep: false };
					return css(to);
				});
				writes.push([el, "background-image", stops]);
				here = first ?? parent;
			} else if (alpha > 0) {
				const from = mix(fill, alpha, parent.from);
				here = { from, to: background(from, cover, surface), keep: false };
				writes.push([el, "background-color", css(here.to)]);
			}
			under.set(el, here);
			if (here.keep) continue;
			const [fore, foreAlpha] = parse(color);
			const shown = mix(fore, foreAlpha, here.from);
			// Text the sender hid by giving it the background's color stays hidden. On a page the mail expects to be
			// dark but paints nothing on, there's nothing to tell that from our default text.
			const hidden = ratio(shown, here.from) < 1.15 && !(own && here === start);
			writes.push([el, "color", css(hidden ? here.to : text(shown, here.to, ink))]);
			for (const { side, color: edge } of borders) {
				const [c, a] = parse(edge);
				if (!a) continue;
				const from = mix(c, a, here.from);
				// A border in the color around it only makes a gap, and one around a whole page would be an edge in the app.
				const gone = ratio(from, parent.from) < 1.05 || (cover >= 0.3 && lch(from).c < 0.035);
				writes.push([el, `border-${side}-color`, css(gone ? parent.to : line(from, surface))]);
			}
		}
		root.style.setProperty("background", css(surface), "important");
		for (const [el, property, value] of writes) el.style.setProperty(property, value, "important");

		for (const img of doc.images) {
			if (img.parentElement && under.get(img.parentElement)?.keep) continue;
			if (img.complete) settle(img);
			else img.addEventListener("load", () => settle(img), { once: true });
		}
	} finally {
		root.style.visibility = "visible";
	}
}
