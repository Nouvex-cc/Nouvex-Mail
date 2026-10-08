// SPDX-License-Identifier: Apache-2.0
import { Accordion as BaseAccordion } from "@base-ui/react/accordion";
import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";
import { ChevronRight } from "lucide-react";
import { cn, type Styled } from "../lib";

const trigger =
	"group flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-medium outline-none select-none hover:bg-hover disabled:text-faint [&_svg]:size-4 [&_svg]:shrink-0";
const chevron = "text-muted transition-transform duration-150 ease-out group-data-panel-open:rotate-90";

function Item({ className, ...props }: Styled<BaseAccordion.Item.Props>) {
	return <BaseAccordion.Item className={cn("border-b border-line last:border-b-0", className)} {...props} />;
}

function Trigger({ className, children, ...props }: Styled<BaseAccordion.Trigger.Props>) {
	return (
		<BaseAccordion.Header>
			<BaseAccordion.Trigger className={cn(trigger, "justify-between", className)} {...props}>
				{children}
				<ChevronRight strokeWidth={1.75} className={chevron} />
			</BaseAccordion.Trigger>
		</BaseAccordion.Header>
	);
}

function Panel({ className, children, ...props }: Styled<BaseAccordion.Panel.Props>) {
	return (
		<BaseAccordion.Panel
			className="h-(--accordion-panel-height) overflow-hidden transition-all duration-150 ease-out starting:h-0 ending:h-0"
			{...props}
		>
			<div className={cn("px-2 pt-1 pb-3", className)}>{children}</div>
		</BaseAccordion.Panel>
	);
}

export const Accordion = { Root: BaseAccordion.Root, Item, Trigger, Panel };

// Chevron sits in front, like a folder tree.
function CollapsibleTrigger({ className, children, ...props }: Styled<BaseCollapsible.Trigger.Props>) {
	return (
		<BaseCollapsible.Trigger className={cn(trigger, className)} {...props}>
			<ChevronRight strokeWidth={1.75} className={chevron} />
			{children}
		</BaseCollapsible.Trigger>
	);
}

function CollapsiblePanel({ className, ...props }: Styled<BaseCollapsible.Panel.Props>) {
	return (
		<BaseCollapsible.Panel
			className={cn(
				"h-(--collapsible-panel-height) overflow-hidden transition-all duration-150 ease-out starting:h-0 ending:h-0",
				className,
			)}
			{...props}
		/>
	);
}

export const Collapsible = { Root: BaseCollapsible.Root, Trigger: CollapsibleTrigger, Panel: CollapsiblePanel };
