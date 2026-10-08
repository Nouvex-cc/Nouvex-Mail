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
				<BaseToast.Viewport className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-90 outline-none sm:bottom-6">
					<ToastList />
				</BaseToast.Viewport>
			</BaseToast.Portal>
		</BaseToast.Provider>
	);
}

// A deck: see toast-card in styles.css for how cards stack, fan out and leave.
function ToastList() {
	const { toasts } = BaseToast.useToastManager();
	return toasts.map((toast) => (
		<BaseToast.Root
			key={toast.id}
			toast={toast}
			swipeDirection={["down", "right"]}
			className="toast-card cursor-default rounded-lg border border-line bg-raised text-ink shadow-pop select-none focus-visible:outline-2 focus-visible:-outline-offset-1"
		>
			<BaseToast.Content className="toast-content flex items-center gap-3 overflow-hidden py-2.5 pr-2 pl-3.5">
				<div className="grid min-w-0 flex-1 gap-0.5">
					<BaseToast.Title className="truncate font-medium" />
					<BaseToast.Description className="text-sm text-muted" />
				</div>
				<BaseToast.Action className="h-7 shrink-0 rounded-md px-2 text-sm font-semibold transition-colors duration-100 hover:bg-hover" />
				<BaseToast.Close
					aria-label="Dismiss"
					className="grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors duration-100 hover:bg-hover hover:text-ink [&_svg]:size-4"
				>
					<X strokeWidth={1.75} />
				</BaseToast.Close>
			</BaseToast.Content>
		</BaseToast.Root>
	));
}
