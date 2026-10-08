// SPDX-License-Identifier: Apache-2.0
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { Kbd } from "./kbd";

export const TooltipProvider = BaseTooltip.Provider;

export type TooltipProps = {
	content: ReactNode;
	shortcut?: string;
	side?: BaseTooltip.Positioner.Props["side"];
	children: ReactElement;
};

export function Tooltip({ content, shortcut, side, children }: TooltipProps) {
	return (
		<BaseTooltip.Root>
			<BaseTooltip.Trigger render={children} />
			<BaseTooltip.Portal>
				<BaseTooltip.Positioner side={side} sideOffset={6} className="z-50">
					<BaseTooltip.Popup className="flex origin-(--transform-origin) items-center gap-2 rounded-md bg-ink px-2 py-1 text-sm text-on-ink shadow-pop transition duration-100 ease-out data-instant:transition-none starting:scale-98 starting:opacity-0 ending:opacity-0 [&_kbd]:border-on-ink/30 [&_kbd]:text-on-ink/70">
						{content}
						{shortcut && <Kbd>{shortcut}</Kbd>}
					</BaseTooltip.Popup>
				</BaseTooltip.Positioner>
			</BaseTooltip.Portal>
		</BaseTooltip.Root>
	);
}
