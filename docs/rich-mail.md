# Rich mail

A rich mail brings its own design: any HTML and CSS, Tailwind included, a few interactive components, and the whole reading area in Nouvex. Every other mail app shows the same message as a classic newsletter. Anyone can send one, with any mail app or sending service.

## The message

One `multipart/alternative` with three parts, in this order:

```
multipart/alternative
├─ text/plain              for apps that only show text
├─ text/x-nouvex-html      the designed version, shown by Nouvex
└─ text/html               a classic newsletter, shown by every other app
```

Mail apps show the last part they understand, so `text/html` goes last and apps that don't know `text/x-nouvex-html` skip it. AMP for Email works the same way with `text/x-amp-html`.

`packages/rich` builds the message from one HTML file:

```sh
bunx nouvex-rich build mail.html --from "Nouvex <hello@nouvex.cc>" -o mail.eml
bunx nouvex-rich check mail.html
```

It compiles the Tailwind classes the file uses into a `<style>`, builds the classic version (or takes yours with `--fallback`) and the plain text, and takes the subject from `<title>`.

## The designed part

- A whole HTML document. CSS goes in `<style>` or `style` attributes; there's no `<link>`.
- No scripts of its own: no `<script>`, no `on…` attributes, no `<iframe>`, `<object>`, `<embed>`, `<form>` or `<base>`, no meta refresh. `check` refuses them.
- Pictures and fonts over https load through Nouvex's server, so the sender never sees the reader's address. `data:` URIs work too.
- At most 500 KB, CSS and inline pictures included.
- Light and dark: use `prefers-color-scheme` (Tailwind's `dark:`); Nouvex follows the reader's theme.
- CSS-only interactivity works as anywhere: `peer-checked:`, `group-open:`, `has-[…]:`, `<details>`, scroll snapping.

## Components

Custom elements that Nouvex brings to life. They are inline by default like any unknown element, so give containers `block` or another display. In the classic version they're laid out flat.

| Element | What it does | In the classic version |
|---|---|---|
| `<nx-carousel>` | Its children become slides you swipe or step through with arrow keys. It adds `[data-nx-dots]` with one `button[data-nx-dot]` per slide, the current one `aria-current="true"`. | Slides one under another |
| `<nx-tabs>` with `<nx-tab label="…">` | Adds a `[role=tablist]` of `button[role=tab]` (`aria-selected`) in front; the other tabs get `hidden`. `selected` on a tab picks it first. | Each tab under its label |
| `<nx-accordion>` with `<nx-item label="…">` | Each item gets a `button` (`aria-expanded`) and a panel that opens and closes. `open` starts it open. | Every answer open under its question |
| `<nx-form action="https://…">` | Collects its named `input`, `textarea` and `select` fields when a `button[type=submit]` or `[data-nx-submit]` is pressed. After the reader confirms, Nouvex posts them as JSON to `action`, from its server. The form gets `data-state="sending"`, then `sent` or `error`. | A button to `web="…"`, labelled `label="…"`, or nothing |
| `<nx-countdown to="2026-12-01T09:00:00Z">` | Shows the time left, like `3d 4h 12m`, and `data-state="done"` at zero. | The date |
| `<nx-action href="nouvex:…">` | Opens a place in Nouvex, like `nouvex:settings/order`. Only in mail Nouvex puts into its users' inboxes itself; elsewhere it does nothing. | A button to `web="…"`, or nothing |

Style what the components add with Tailwind's arbitrary variants, for example `[&_[data-nx-dot][aria-current=true]]:bg-black` or `group-data-[state=sent]:block`.

## What a form sends

```http
POST https://… (the form's action)
Content-Type: application/json

{"answer": "By client"}
```

The reader sees where it goes and confirms first. Nouvex sends it from its server, so the sender gets the answer but not the reader's address. Any 2xx answer counts as sent; nothing is stored.

## How Nouvex shows it

The designed part fills the reading area, with a slim bar above it (back, sender, "Show classic"). It runs without the mail's own scripts and can't load anything but its pictures and fonts through the proxy. The components run in a separate runtime, `packages/rich/runtime.js`, the same file on the web and on Apple devices.
