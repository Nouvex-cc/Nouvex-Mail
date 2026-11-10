// SPDX-License-Identifier: AGPL-3.0-only
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// API_URL points the dev server at an API on another port.
const api = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig({
	plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
	resolve: { tsconfigPaths: true },
	server: {
		proxy: {
			"/api": api,
			"/accounts": api,
			"/hosted-accounts": api,
			"/groups": api,
			"/order": api,
			"/rich": api,
			"/rules": api,
			"/unsubscribe": api,
			"/keys": api,
			"/password": api,
			"/invites": api,
			"/prefs": api,
			"/image": api,
			"/ws": { target: api.replace(/^http/, "ws"), ws: true },
		},
	},
});
