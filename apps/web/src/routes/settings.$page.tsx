// SPDX-License-Identifier: AGPL-3.0-only
import { flash } from "@nouvex/ui";
import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { useSections } from "../settings/registry";

export const Route = createFileRoute("/settings/$page")({ component: SettingsPage });

function SettingsPage() {
	const { page } = Route.useParams();
	const hash = useLocation({ select: (l) => l.hash });
	const found = useSections()
		.flatMap((s) => s.pages)
		.find((p) => p.id === page);

	// Account pages arrive with their data, so the row may only exist a moment later; same row on another page lands too.
	const ready = found?.id;
	useEffect(() => {
		if (ready && hash) flash(hash);
	}, [ready, hash]);

	return found?.render() ?? null;
}
