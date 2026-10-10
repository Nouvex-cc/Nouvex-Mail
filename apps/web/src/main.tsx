// SPDX-License-Identifier: AGPL-3.0-only
import { ToastProvider } from "@nouvex/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { routeTree } from "./routeTree.gen";
import "./index.css";

const queryClient = new QueryClient();
const router = createRouter({ routeTree, context: { queryClient } });

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

// biome-ignore lint/style/noNonNullAssertion: root is in index.html
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<ToastProvider>
				<RouterProvider router={router} />
			</ToastProvider>
		</QueryClientProvider>
	</StrictMode>,
);
