// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	const health = useQuery({
		queryKey: ["health"],
		queryFn: () => fetch("/health").then((r) => r.json() as Promise<{ ok: boolean }>),
	});
	return (
		<main className="grid min-h-screen place-items-center">
			<div className="text-center">
				<h1 className="text-3xl font-semibold">Nouvex Mail</h1>
				<p className="text-sm text-muted">API: {health.data?.ok ? "up" : "down"}</p>
			</div>
		</main>
	);
}
