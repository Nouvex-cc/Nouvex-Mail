// SPDX-License-Identifier: AGPL-3.0-only
import { AppShell, Settings, Sidebar } from "@nouvex/ui";
import { ChevronLeft } from "@nouvex/ui/icons";
import { createFileRoute, Outlet, redirect, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { session } from "../auth";
import { find, useSections } from "../settings/registry";

export const Route = createFileRoute("/settings")({
	beforeLoad: async () => {
		const { data } = await session();
		if (!data) throw redirect({ to: "/login" });
	},
	component: SettingsShell,
});

function SettingsShell() {
	const navigate = useNavigate();
	const current = useParams({ strict: false }).page;
	const sections = useSections();
	const [query, setQuery] = useState("");
	const hits = find(
		sections.flatMap((s) => s.pages),
		query,
	);

	return (
		<AppShell
			className="h-screen"
			logo={<span role="img" aria-label="Nouvex" className="logo" />}
			sidebar={
				<Sidebar.Root>
					<Sidebar.Section>
						<Sidebar.Item
							label="Inbox"
							icon={<ChevronLeft strokeWidth={1.75} />}
							onSelect={() => navigate({ to: "/" })}
						/>
					</Sidebar.Section>
					{sections.map(({ module, pages }) => (
						<Sidebar.Section key={module.title} title={module.title}>
							{pages.map((p) => (
								<Sidebar.Item
									key={p.id}
									label={p.title}
									icon={p.icon}
									active={p.id === current}
									onSelect={() => navigate({ to: "/settings/$page", params: { page: p.id } })}
								/>
							))}
							{module.action && <module.action />}
						</Sidebar.Section>
					))}
				</Sidebar.Root>
			}
			header={
				<Settings.Search
					className="w-full max-w-xl"
					query={query}
					onQuery={setQuery}
					results={hits.map(({ page, entry }) => ({
						key: `${page.id}#${entry?.id ?? ""}`,
						label: entry?.label ?? page.title,
						where: entry ? page.title : "",
						icon: page.icon,
					}))}
					onPick={(r) => {
						const [page = "", hash] = r.key.split("#");
						navigate({ to: "/settings/$page", params: { page }, hash: hash || undefined });
					}}
				/>
			}
		>
			<Outlet />
		</AppShell>
	);
}
