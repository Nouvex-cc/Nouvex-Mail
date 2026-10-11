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
