// SPDX-License-Identifier: AGPL-3.0-only

export type Theme = "system" | "light" | "dark";

// A per-device choice, so it lives in this browser; the styles follow .light/.dark on the root, or the system.
export function storedTheme(): Theme {
	try {
		const t = localStorage.getItem("theme");
		return t === "light" || t === "dark" ? t : "system";
	} catch {
		return "system";
	}
}

export function applyTheme(theme: Theme) {
	const root = document.documentElement.classList;
	root.toggle("light", theme === "light");
	root.toggle("dark", theme === "dark");
	try {
		localStorage.setItem("theme", theme);
	} catch {}
}

/** Colors and the inbox background, built in Settings. Per device too, like the theme. */
export type Look = {
	/** ink: no hue; accent: the hue on what's on and new; tinted: the frame takes it on too; frame: the frame is it. */
	tone: "ink" | "accent" | "tinted" | "frame";
	hue: number;
	/** Every person keeps a color in their avatar. */
	people: boolean;
	image?: string;
	blur: number;
	grain: number;
	strength: number;
};

export const plain: Look = { tone: "ink", hue: 255, people: false, blur: 24, grain: 0.3, strength: 0.35 };

export const presets: { name: string; look: Partial<Look> }[] = [
	{ name: "Paper", look: { tone: "ink", people: false } },
	{ name: "Ocean", look: { tone: "accent", hue: 245, people: false } },
	{ name: "Meadow", look: { tone: "tinted", hue: 155, people: false } },
	{ name: "Dusk", look: { tone: "frame", hue: 285, people: false } },
	{ name: "Ember", look: { tone: "accent", hue: 45, people: true } },
	{ name: "Friends", look: { tone: "ink", people: true } },
];

export function storedLook(): Look {
	try {
		const image = localStorage.getItem("look-image") ?? undefined;
		return { ...plain, ...JSON.parse(localStorage.getItem("look") ?? "{}"), image };
	} catch {
		return plain;
	}
}

/** Applies the colors to the page and remembers everything; false when the browser had no room to store it. */
export function applyLook(look: Look) {
	const root = document.documentElement;
	root.dataset.tone = look.tone;
	root.style.setProperty("--hue", String(look.hue));
	if (look.people) root.dataset.people = "color";
	else delete root.dataset.people;
	// The image is stored apart and only when it changes: sliders save on every step.
	const { image, ...rest } = look;
	try {
		localStorage.setItem("look", JSON.stringify(rest));
		if (!image) localStorage.removeItem("look-image");
		else if (image !== localStorage.getItem("look-image")) localStorage.setItem("look-image", image);
		return true;
	} catch {
		return false;
	}
}

/** A picked photo, scaled down so it fits the browser's storage and stays quick to draw. */
export async function shrink(file: File, max = 1920) {
	const bitmap = await createImageBitmap(file);
	const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	return canvas.toDataURL("image/jpeg", 0.82);
}
