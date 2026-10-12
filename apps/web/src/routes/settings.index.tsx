// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/")({
	beforeLoad: () => {
		throw redirect({ to: "/settings/$page", params: { page: "appearance" }, replace: true });
	},
});
