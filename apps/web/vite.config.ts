// SPDX-License-Identifier: AGPL-3.0-only
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
	resolve: { tsconfigPaths: true },
	server: {
		proxy: {
			"/api": "http://localhost:3000",
			"/accounts": "http://localhost:3000",
			"/ws": { target: "ws://localhost:3000", ws: true },
		},
	},
});
