// SPDX-License-Identifier: Apache-2.0
// The runtime as the clients load it (runtime.js): it talks to the web app through postMessage and to the Apple apps
// through a message handler, which answer a form with nxAnswer.
import { enhance, type Outgoing } from "./runtime";

type Handler = { postMessage(message: unknown): void };
const apple = (globalThis as { webkit?: { messageHandlers?: { rich?: Handler } } }).webkit?.messageHandlers?.rich;
const waiting = new Map<number, (ok: boolean) => void>();
let next = 0;

const answer = (id: number, ok: boolean) => {
	waiting.get(id)?.(ok);
	waiting.delete(id);
};
(globalThis as { nxAnswer?: typeof answer }).nxAnswer = answer;
addEventListener("message", (e) => {
	if (e.source === parent && e.data?.type === "answer") answer(e.data.id, !!e.data.ok);
});

enhance(document, (message: Outgoing) => {
	const id = ++next;
	if (apple) apple.postMessage({ ...message, id });
	else parent.postMessage({ ...message, id }, "*");
	if (message.type === "action") return Promise.resolve(true);
	return new Promise((resolve) => waiting.set(id, resolve));
});
