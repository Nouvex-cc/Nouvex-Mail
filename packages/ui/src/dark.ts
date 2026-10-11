// SPDX-License-Identifier: Apache-2.0
import { useSyncExternalStore } from "react";

// The app is dark with .dark on the root, or without .light when the system is dark.
const darkQuery = typeof matchMedia === "undefined" ? undefined : matchMedia("(prefers-color-scheme: dark)");
const isDark = () => {
	const root = document.documentElement.classList;
	return root.contains("dark") || (!root.contains("light") && !!darkQuery?.matches);
};
export function useDark() {
	return useSyncExternalStore((change) => {
		darkQuery?.addEventListener("change", change);
		const classes = new MutationObserver(change);
		classes.observe(document.documentElement, { attributeFilter: ["class"] });
		return () => {
			darkQuery?.removeEventListener("change", change);
			classes.disconnect();
		};
	}, isDark);
}
