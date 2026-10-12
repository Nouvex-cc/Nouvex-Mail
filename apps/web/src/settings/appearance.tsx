// SPDX-License-Identifier: AGPL-3.0-only
import { Backdrop, Button, Settings, Slider, Switch, Toggle, ToggleGroup, useToast } from "@nouvex/ui";
import { Palette } from "@nouvex/ui/icons";
import { useRef, useState } from "react";
import { applyLook, applyTheme, type Look, presets, shrink, storedLook, storedTheme, type Theme } from "../theme";
import type { Module, Page } from "./registry";

const hues = [
	[15, "Rose"],
	[45, "Amber"],
	[95, "Lime"],
	[155, "Green"],
	[200, "Teal"],
	[245, "Blue"],
	[285, "Violet"],
	[330, "Pink"],
] as const;

// Colors take effect on the whole page as they're picked; the background shows in the preview here and behind the
// inbox list.
function Appearance() {
	const toast = useToast();
	const [theme, setTheme] = useState(storedTheme);
	const [look, setLook] = useState(storedLook);
	const picker = useRef<HTMLInputElement>(null);
	// How much of the image the backdrop lets through, after keeping text readable.
	const [shown, setShown] = useState(1);
	const change = (next: Partial<Look>) => {
		const merged = { ...look, ...next };
		setLook(merged);
		if (!applyLook(merged)) toast.add({ title: "Couldn't keep the image", description: "Try a smaller one." });
	};
	const active = presets.find((p) => Object.entries(p.look).every(([k, v]) => look[k as keyof Look] === v))?.name;

	return (
		<Settings.Page title="Appearance">
			<Settings.Section>
				<Settings.Row id="mode" label="Mode" hint="System follows your device">
					<ToggleGroup
						value={[theme]}
						onValueChange={(v) => {
							const next = (v[0] as Theme | undefined) ?? theme;
							setTheme(next);
							applyTheme(next);
						}}
					>
						<Toggle value="system">System</Toggle>
						<Toggle value="light">Light</Toggle>
						<Toggle value="dark">Dark</Toggle>
					</ToggleGroup>
				</Settings.Row>
			</Settings.Section>

			<Settings.Section title="Colors">
				<Settings.Row id="theme" label="Theme" stack>
					<div className="grid grid-cols-3 gap-2">
						{presets.map((p) => (
							<button
								key={p.name}
								type="button"
								data-active={active === p.name || undefined}
								onClick={() => change(p.look)}
								className="flex h-11 items-center gap-2.5 rounded-lg border border-line px-3 text-left outline-none transition-colors duration-100 hover:bg-hover focus-visible:outline-2 data-active:border-accent data-active:bg-accent-soft"
							>
								<span
									className={p.look.tone === "ink" ? "size-4 rounded-full bg-ink" : "hue-swatch size-4 rounded-full"}
									style={{ "--hue": p.look.hue } as React.CSSProperties}
								/>
								{p.name}
							</button>
						))}
					</div>
				</Settings.Row>
				<Settings.Row
					id="tone"
					label="Where the color goes"
					hint="Accent marks what's on and new, the frame can take it on too"
				>
					<ToggleGroup value={[look.tone]} onValueChange={(v) => v[0] && change({ tone: v[0] as Look["tone"] })}>
						<Toggle value="ink">Ink</Toggle>
						<Toggle value="accent">Accent</Toggle>
						<Toggle value="tinted">Tinted</Toggle>
						<Toggle value="frame">Frame</Toggle>
					</ToggleGroup>
				</Settings.Row>
				<Settings.Row
					id="hue"
					label="Color"
					hint={look.tone === "ink" ? "Pick a tone other than Ink first" : undefined}
				>
					<div className="flex gap-2" aria-disabled={look.tone === "ink"}>
						{hues.map(([hue, name]) => (
							<button
								key={hue}
								type="button"
								aria-label={name}
								aria-pressed={look.hue === hue}
								disabled={look.tone === "ink"}
								onClick={() => change({ hue })}
								className="hue-swatch size-6 rounded-full outline-offset-2 transition duration-150 ease-out hover:scale-110 focus-visible:outline-2 disabled:opacity-30 disabled:hover:scale-100 aria-pressed:outline-2 aria-pressed:outline-ink"
								style={{ "--hue": hue } as React.CSSProperties}
							/>
						))}
					</div>
				</Settings.Row>
				<Settings.Row id="people" label="Give every person a color" hint="In their avatar, the same everywhere">
					<Switch
						aria-label="Give every person a color"
						checked={look.people}
						onCheckedChange={(people) => change({ people })}
					/>
				</Settings.Row>
			</Settings.Section>

			<Settings.Section title="Inbox background">
				<Settings.Row id="background" label="Picture" hint="Shown behind the list, never behind a conversation" stack>
					<div className="backdrop-host relative h-36 overflow-hidden rounded-lg border border-line bg-paper">
						{look.image && (
							<Backdrop
								src={look.image}
								blur={look.blur}
								grain={look.grain}
								strength={look.strength}
								onFit={setShown}
							/>
						)}
						<div className="relative grid gap-2 p-4">
							{["Lena Hartmann", "Vivid Money", "Jonas Weber"].map((name, i) => (
								<div key={name} className="flex gap-3 text-sm">
									<span className={i < 2 ? "w-28 font-semibold" : "w-28 text-muted"}>{name}</span>
									<span className={i < 2 ? "" : "text-muted"}>Keys for the new flat</span>
								</div>
							))}
						</div>
					</div>
					<div className="flex gap-2">
						<Button size="sm" onClick={() => picker.current?.click()}>
							{look.image ? "Choose another" : "Choose picture"}
						</Button>
						{look.image && (
							<Button size="sm" variant="ghost" onClick={() => change({ image: undefined })}>
								Remove
							</Button>
						)}
						<input
							ref={picker}
							type="file"
							accept="image/*"
							hidden
							onChange={async (e) => {
								const file = e.target.files?.[0];
								e.target.value = "";
								if (file) change({ image: await shrink(file) });
							}}
						/>
					</div>
				</Settings.Row>
				{look.image && (
					<Settings.Row
						id="picture-look"
						label="Blur, grain and strength"
						hint={
							shown < look.strength - 0.02
								? `Shown at ${Math.round(shown * 100)}% so text stays readable. More blur lets more of it through.`
								: undefined
						}
						stack
					>
						<div className="grid gap-4 sm:grid-cols-3">
							<Slider
								label="Blur"
								min={0}
								max={60}
								value={look.blur}
								onValueChange={(v) => change({ blur: v as number })}
							/>
							<Slider
								label="Grain"
								min={0}
								max={1}
								step={0.05}
								value={look.grain}
								onValueChange={(v) => change({ grain: v as number })}
							/>
							<Slider
								label="Strength"
								min={0.05}
								max={1}
								step={0.05}
								value={look.strength}
								onValueChange={(v) => change({ strength: v as number })}
							/>
						</div>
					</Settings.Row>
				)}
			</Settings.Section>
		</Settings.Page>
	);
}

const appearance: Page = {
	id: "appearance",
	title: "Appearance",
	icon: <Palette strokeWidth={1.75} />,
	entries: [
		{ id: "mode", label: "Mode", keywords: "dark light system night" },
		{ id: "theme", label: "Theme", keywords: "preset ocean meadow dusk ember friends paper" },
		{ id: "tone", label: "Where the color goes", keywords: "accent tinted frame ink tone" },
		{ id: "hue", label: "Color", keywords: "hue accent" },
		{ id: "people", label: "Give every person a color", keywords: "avatar people" },
		{ id: "background", label: "Inbox background", keywords: "picture image photo wallpaper" },
	],
	render: () => <Appearance />,
};

export const app: Module = { title: "App", usePages: () => [appearance] };
