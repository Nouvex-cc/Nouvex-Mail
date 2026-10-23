// SPDX-License-Identifier: Apache-2.0
// Brings the components of a rich mail to life (docs/rich-mail.md). It runs apart from the mail, which has no script
// of its own: in a sandboxed frame on the web, in its own content world on Apple. It only changes the DOM, so it works
// from either; the client decides what a form or an action does.

export type Outgoing =
	| { type: "form"; action: string; fields: Record<string, string | string[]> }
	| { type: "action"; href: string };

/** Hands a request to the client; a form learns whether it went through. */
export type Send = (message: Outgoing) => Promise<boolean>;

const set = (el: HTMLElement, style: Partial<CSSStyleDeclaration>) => Object.assign(el.style, style);

function carousel(el: HTMLElement) {
	const doc = el.ownerDocument;
	const slides = [...el.children] as HTMLElement[];
	if (!slides.length) return;
	const track = doc.createElement("div");
	track.dataset.nxTrack = "";
	track.tabIndex = 0;
	track.setAttribute("aria-roledescription", "carousel");
	set(track, { display: "flex", overflowX: "auto", scrollSnapType: "x mandatory", scrollbarWidth: "none" });
	for (const [i, s] of slides.entries()) {
		set(s, { flex: "0 0 100%", scrollSnapAlign: "start" });
		s.setAttribute("aria-label", `${i + 1} of ${slides.length}`);
	}
	track.append(...slides);
	const dots = doc.createElement("div");
	dots.dataset.nxDots = "";
	const go = (i: number) =>
		track.scrollTo({ left: track.clientWidth * Math.max(0, Math.min(i, slides.length - 1)), behavior: "smooth" });
	const buttons = slides.map((_, i) => {
		const b = doc.createElement("button");
		b.type = "button";
		b.dataset.nxDot = "";
		b.setAttribute("aria-label", `Slide ${i + 1}`);
		b.addEventListener("click", () => go(i));
		return b;
	});
	dots.append(...buttons);
	const current = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
	const mark = () => {
		for (const [i, b] of buttons.entries()) b.setAttribute("aria-current", String(i === current()));
	};
	track.addEventListener("scroll", mark, { passive: true });
	track.addEventListener("keydown", (e) => {
		if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
			e.preventDefault();
			go(current() + (e.key === "ArrowRight" ? 1 : -1));
		}
	});
	el.append(track, dots);
	mark();
}

function tabs(el: HTMLElement) {
	const doc = el.ownerDocument;
	const panels = [...el.querySelectorAll(":scope > nx-tab")] as HTMLElement[];
	const list = doc.createElement("div");
	list.setAttribute("role", "tablist");
	const buttons = panels.map((p, i) => {
		const b = doc.createElement("button");
		b.type = "button";
		b.setAttribute("role", "tab");
		b.textContent = p.getAttribute("label") ?? `${i + 1}`;
		p.setAttribute("role", "tabpanel");
		b.addEventListener("click", () => pick(i));
		b.addEventListener("keydown", (e) => {
			const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
			if (!step) return;
			const next = (i + step + panels.length) % panels.length;
			pick(next);
			buttons[next]?.focus();
		});
		return b;
	});
	const pick = (n: number) => {
		for (const [i, b] of buttons.entries()) {
			b.setAttribute("aria-selected", String(i === n));
			b.tabIndex = i === n ? 0 : -1;
			if (panels[i]) panels[i].hidden = i !== n;
		}
	};
	list.append(...buttons);
	el.prepend(list);
	pick(
		Math.max(
			0,
			panels.findIndex((p) => p.hasAttribute("selected")),
		),
	);
}

function accordion(el: HTMLElement) {
	const doc = el.ownerDocument;
	for (const item of el.querySelectorAll(":scope > nx-item") as NodeListOf<HTMLElement>) {
		const panel = doc.createElement("div");
		panel.append(...item.childNodes);
		const b = doc.createElement("button");
		b.type = "button";
		b.textContent = item.getAttribute("label") ?? "";
		const open = (on: boolean) => {
			b.setAttribute("aria-expanded", String(on));
			panel.hidden = !on;
			item.toggleAttribute("open", on);
		};
		b.addEventListener("click", () => open(b.getAttribute("aria-expanded") !== "true"));
		item.append(b, panel);
		open(item.hasAttribute("open"));
	}
}

function form(el: HTMLElement, send: Send) {
	const action = el.getAttribute("action") ?? "";
	const fields = () => {
		const out: Record<string, string | string[]> = {};
		for (const f of el.querySelectorAll("input[name], textarea[name], select[name]") as NodeListOf<HTMLInputElement>) {
			if ((f.type === "checkbox" || f.type === "radio") && !f.checked) continue;
			const had = out[f.name];
			out[f.name] = had === undefined ? f.value : [...[had].flat(), f.value];
		}
		return out;
	};
	const submit = async () => {
		const invalid = [...el.querySelectorAll("input, textarea, select")].find(
			(f) => !(f as HTMLInputElement).checkValidity(),
		);
		if (invalid) return (invalid as HTMLInputElement).reportValidity();
		el.dataset.state = "sending";
		el.dataset.state = (await send({ type: "form", action, fields: fields() })) ? "sent" : "error";
	};
	for (const b of el.querySelectorAll("[data-nx-submit], button[type=submit]"))
		b.addEventListener("click", () => void submit());
	el.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") void submit();
	});
}

function countdown(el: HTMLElement) {
	const to = Date.parse(el.getAttribute("to") ?? "");
	if (Number.isNaN(to)) return;
	const tick = () => {
		const left = Math.max(0, to - Date.now());
		const m = Math.floor(left / 60_000);
		el.textContent = [
			Math.floor(m / 1440) && `${Math.floor(m / 1440)}d`,
			Math.floor(m / 60) % 24 && `${Math.floor(m / 60) % 24}h`,
			`${m % 60}m`,
		]
			.filter(Boolean)
			.join(" ");
		if (!left) el.dataset.state = "done";
		return left;
	};
	if (tick()) {
		const timer = setInterval(() => tick() || clearInterval(timer), 30_000);
	}
}

function action(el: HTMLElement, send: Send) {
	const href = el.getAttribute("href") ?? "";
	el.setAttribute("role", "button");
	el.tabIndex = 0;
	const go = () => void send({ type: "action", href });
	el.addEventListener("click", go);
	el.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && go());
}

/** Wires every component in the document; run it once, after the mail has loaded. */
export function enhance(doc: Document, send: Send) {
	const each = (tag: string, f: (el: HTMLElement) => void) => {
		for (const el of doc.querySelectorAll(tag) as NodeListOf<HTMLElement>) f(el);
	};
	each("nx-carousel", carousel);
	each("nx-tabs", tabs);
	each("nx-accordion", accordion);
	each("nx-form", (el) => form(el, send));
	each("nx-countdown", countdown);
	each("nx-action", (el) => action(el, send));
}
