// SPDX-License-Identifier: Apache-2.0
import { Progress as BaseProgress } from "@base-ui/react/progress";
import type { ReactNode } from "react";
import { File, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, X } from "../../icons";
import { cn } from "../../lib";
import { useGlide } from "../glide";

export type AttachmentTileProps = {
	name: string;
	size: number;
	type?: string;
	previewUrl?: string;
	/** Upload progress 0–100; the bar disappears once it reaches 100. */
	progress?: number;
	onRemove?(): void;
	onOpen?(): void;
};

function iconFor(name: string, type = "") {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	if (type.startsWith("image/") || /^(png|jpe?g|gif|webp|heic|svg)$/.test(ext)) return FileImage;
	if (type.startsWith("video/") || /^(mp4|mov|webm)$/.test(ext)) return FileVideo;
	if (type.startsWith("audio/") || /^(mp3|wav|m4a|ogg)$/.test(ext)) return FileAudio;
	if (/^(zip|rar|7z|gz|tar)$/.test(ext)) return FileArchive;
	if (/^(xlsx?|csv|numbers|ods)$/.test(ext)) return FileSpreadsheet;
	if (type.startsWith("text/") || /^(pdf|docx?|txt|md|rtf|pages|odt)$/.test(ext)) return FileText;
	return File;
}

// Truncates in the middle at whatever width the tile has: the start shrinks with an ellipsis, the last few
// characters and the extension always stay ("Handover-prot…final.pdf").
function MiddleTruncate({ name }: { name: string }) {
	const tail = name.slice(-Math.min(name.length, Math.max(8, name.length - name.lastIndexOf(".") + 4)));
	return (
		<span className="flex min-w-0 text-sm font-medium" title={name}>
			<span className="truncate">{name.slice(0, name.length - tail.length)}</span>
			<span className="shrink-0 whitespace-pre">{tail}</span>
		</span>
	);
}

export function formatSize(bytes: number) {
	const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
	let i = 0;
	let value = bytes;
	while (value >= 1000 && i < units.length - 1) {
		value /= 1000;
		i++;
	}
	return new Intl.NumberFormat(undefined, {
		style: "unit",
		unit: units[i],
		unitDisplay: "short",
		maximumFractionDigits: i < 2 ? 0 : 1,
	}).format(value);
}

export function AttachmentTile({ name, size, type, previewUrl, progress, onRemove, onOpen }: AttachmentTileProps) {
	const Icon = iconFor(name, type);
	const uploading = progress !== undefined && progress < 100;
	return (
		<div
			title={name}
			className="group relative flex w-56 items-center gap-2.5 overflow-hidden rounded-md border border-line bg-paper p-2 pr-3 transition-colors duration-100 hover:bg-hover"
		>
			{onOpen && (
				<button
					type="button"
					aria-label={`Open ${name}`}
					onClick={onOpen}
					className="absolute inset-0 rounded-md outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
				/>
			)}
			{previewUrl ? (
				<img src={previewUrl} alt="" className="size-9 shrink-0 rounded-sm object-cover" />
			) : (
				<span className="grid size-9 shrink-0 place-items-center text-muted">
					<Icon strokeWidth={1.75} className="size-5" />
				</span>
			)}
			<span className="grid min-w-0">
				<MiddleTruncate name={name} />
				<span className="text-xs text-muted tabular-nums">
					{formatSize(size)}
					{uploading && ` · ${Math.round(progress)}%`}
				</span>
			</span>
			{onRemove && (
				<button
					type="button"
					aria-label={`Remove ${name}`}
					onClick={onRemove}
					className="relative ml-auto grid size-6 shrink-0 place-items-center rounded-sm text-muted opacity-0 outline-none transition duration-100 group-hover:opacity-100 hover:bg-selected hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 [&_svg]:size-3.5"
				>
					<X strokeWidth={1.75} />
				</button>
			)}
			{progress !== undefined && (
				<BaseProgress.Root
					value={progress}
					aria-label={`Uploading ${name}`}
					className={cn(
						"absolute inset-x-0 bottom-0 transition-opacity duration-300",
						uploading ? "opacity-100" : "opacity-0",
					)}
				>
					<BaseProgress.Track className="h-0.5 w-full">
						<BaseProgress.Indicator className="bg-ink transition-all duration-300 ease-out" />
					</BaseProgress.Track>
				</BaseProgress.Root>
			)}
		</div>
	);
}

/** Wrapping row of tiles; tiles that come or go let the others glide into place. */
export function AttachmentList({ children, className }: { children: ReactNode; className?: string }) {
	const ref = useGlide<HTMLDivElement>({ enter: true, leave: true });
	return (
		<div ref={ref} className={cn("relative flex flex-wrap gap-2", className)}>
			{children}
		</div>
	);
}
