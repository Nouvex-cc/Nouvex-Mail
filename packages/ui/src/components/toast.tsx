// SPDX-License-Identifier: Apache-2.0
import { Toast as BaseToast } from "@base-ui/react/toast";
import { X } from "lucide-react";
import type { ReactNode } from "react";

// Usage: const toast = useToast(); toast.add({ title: "Archived", actionProps: { children: "Undo", onClick } })
export const useToast = BaseToast.useToastManager;
export const createToastManager = BaseToast.createToastManager;

export function ToastProvider({ children, ...props }: BaseToast.Provider.Props & { children: ReactNode }) {
	return (
		<BaseToast.Provider limit={3} {...props}>
			{children}
			<BaseToast.Portal>
				<BaseToast.Viewport className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-full max-w-sm flex-col-reverse gap-2 px-4 outline-none">
					<ToastList />
				</BaseToast.Viewport>
			</BaseToast.Portal>
		</BaseToast.Provider>
	);
}

// Toasts stack in normal flow, not as a collapsed deck. At most three are visible.
function ToastList() {
	const { toasts } = BaseToast.useToastManager();
	return toasts.map((toast) => (
		<BaseToast.Root
			key={toast.id}
			toast={toast}
			className="flex translate-x-(--toast-swipe-movement-x) translate-y-(--toast-swipe-movement-y) select-none items-center gap-3 rounded-lg border border-line bg-raised py-2.5 pr-2 pl-3.5 text-ink shadow-pop transition duration-200 ease-out starting:translate-y-2 starting:opacity-0 ending:opacity-0 ending:duration-150 data-limited:hidden"
		>
			<BaseToast.Content className="grid min-w-0 flex-1 gap-0.5">
				<BaseToast.Title className="font-medium" />
				<BaseToast.Description className="text-sm text-muted" />
			</BaseToast.Content>
			<BaseToast.Action className="h-7 shrink-0 rounded-md px-2 text-sm font-semibold hover:bg-hover" />
			<BaseToast.Close
				aria-label="Dismiss"
				className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-ink [&_svg]:size-4"
			>
				<X strokeWidth={1.75} />
			</BaseToast.Close>
		</BaseToast.Root>
	));
}
