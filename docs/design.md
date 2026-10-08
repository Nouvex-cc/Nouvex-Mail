# Design

Nouvex should feel like a tool you're glad to open because it works, not because it tells you how great it is. Calm and minimal, fast, a little warm. The good moments come from things working better than expected.

## Principles

**Content first.** Mail is the interface. Chrome stays quiet: no hero areas, no marketing copy, no onboarding banners inside the product.

**Only show what changes a decision.** No eyebrow labels over headings, no totals nobody asked for ("1,284 messages"), no "last synced 3 min ago" unless sync is actually broken. Inbox gets an unread dot, not a number.

**Fast beats pretty.** Every action has a keyboard shortcut. Nothing waits for an animation. Optimistic updates by default, the network catches up.

**Native where it matters.** Apple apps use SwiftUI controls, SF Pro and SF Symbols. The web uses our own library. What's shared: palette, tone of voice, spacing logic, shortcuts.

**Delight is made by people.** Easter eggs, playful transitions and the "wait, that works here?" moments are designed by the team and get as many iterations as they need. They are never generated, never filler, and never get in the way of a fast workflow.

## Palette

Warm neutrals, never pure black or white. The accent is ink, same as the logo. Color only appears when it means something.

| Token | Use |
|---|---|
| `paper` | app background |
| `sunken` | sidebar, wells |
| `raised` | popovers, menus, dialogs |
| `ink` | text, primary buttons, focus ring, unread dot |
| `muted` | secondary text |
| `faint` | placeholders, disabled |
| `line` / `line-strong` | dividers / input borders |
| `hover` / `selected` | row and item states |
| `danger` | destructive actions, errors |
| `scrim` | dimmed backdrop behind dialogs |
| `hold` | fill of a hold-to-confirm button |
| `positive` | confirmed actions (button success state) |

Mail labels get one of six muted hues (`--label-gray`, `red`, `orange`, `green`, `blue`, `purple`) as a tag: a tag-shaped icon in the sidebar, a tinted chip with darker text in front of the subject. That's the only color beyond the palette above, and it carries information.

Raw Tailwind colors don't exist in this project (the default palette is removed), so `bg-blue-500` won't compile into anything.

## Type

Schibsted Grotesk on the web, SF Pro on Apple. Base size is 14px, the app is dense but not cramped.

| Token | Size | Use |
|---|---|---|
| `text-xs` | 12 | timestamps, shortcuts |
| `text-sm` | 13 | snippets, secondary UI |
| `text-base` | 14 | default |
| `text-lg` | 16 | message body |
| `text-xl` | 18 | message subject |
| `text-2xl` | 22 | page titles (settings) |
| `text-3xl` | 28 | rare, empty states |

Weights: 400 body, 500 UI labels, 600 emphasis and unread. No light weights, no all-caps labels.

## Shape and depth

Radius `sm` 6, `md` 8, `lg` 12, `xl` 20. Inputs and buttons use `md`, popups `lg`. Cards about a person (the sender card) are softer: `xl` with filled pill buttons, no outlines. Borders separate, shadows only lift things that float (`shadow-pop`, `shadow-dialog`). Never both a heavy border and a shadow on the same element.

## Motion

120 to 200 ms, ease-out, enter slightly faster than exit. Popups fade and scale from 98%, dialogs from 96%. Nothing animates on page load. `prefers-reduced-motion` turns everything into instant changes.

Loading buttons darken and a short segment of their outline runs around them (`<Button loading>`). The segment grows in over about 450 ms and shrinks out in about 150 ms. The button stays where it is, keeps its label and ignores further clicks. With reduced motion the full outline shows instead. Spinners are for things that aren't buttons.

In lists (menus, selects, comboboxes, the command palette) one highlight slides to the focused item instead of items lighting up one by one. Chips (recipients) scale in when added and fade out in place when removed, quick enough never to be waited on; the rest glides.

A select opens over its trigger: the chosen row lands exactly on the trigger's tile, the list unfolds up and down out of it, and picking another row folds the list back while that row glides onto the trigger. Rows run edge to edge, so the row on the trigger is the trigger's size. The account picker and the calendar's month and year use the same select. Where there's no room (or on touch) the list drops below and fades in.

Sliders have an upright rounded bar instead of a round knob; it grows a little while hovered or dragged. Clicking further along the track glides it there (120 ms); dragging follows the pointer directly.

Controls give slightly under the finger: buttons, toggles, checkboxes and radios press in a little (not a trigger that opens a list over itself, the list would land off by the press), a switch's thumb stretches once while it travels. A checkbox's check strokes itself in, a radio's dot grows from the center. Single-choice toggle groups slide one pill to the active option, like lists. Toasts form a deck at the bottom: the newest in front, older ones as slightly smaller cards peeking out behind with their text hidden. Hovering or focusing fans the deck out; new toasts rise from below, dismissed ones drop away or follow a swipe to the side, and the timer pauses while the pointer is on them. Fields get the focus ring with a small gap around them, so it never sits on the border, avatars fade in once their image has loaded.

Calendars page with a short fade-through: the old month fades out almost in place, the new one fades in from the paging direction once the old one is gone, so dates never overlap. The month name crossfades while the year stays put. Month and year each open a list around themselves (all months, three years either side) and also take typing: the middle row turns into the field showing what you type and the best match is highlighted; Enter takes it or a typed value outside the list (a year like 1850, a month number). Today has a dot, the week starts on the user's regional first day, and picking a date closes the picker.

Ranges are picked by clicking start and end, or by pressing a day and dragging across the others, the way you select several photos at once. The band between start and end rounds off at each week's edge.

Date fields are typed first; the button on their right opens the calendar. They take almost any way of writing a date (15.10.2026, 10/15/26, 20261015, Oct 15, 15. Oktober, tomorrow, in 2 weeks, friday) and rewrite it in the user's own format. Something that isn't a date stays visible and turns red; Escape restores.

Text fields draw their own caret: it glides to the next character (90 ms) instead of jumping, stays solid while typing and only blinks once you pause. Email and number fields keep the native caret because browsers don't report its position there.

When an action needs confirming, the button turns green for about 1.5 s and its label morphs into the past tense with a check in front (`<Button success="Saved">`): letters both words share stay and glide, the rest fades. The button keeps its size, so nothing around it moves: pass every label it can show (`labels={["Undo", "Sent"]}`) and it sizes to the widest. Leaving letters travel with their neighbours and slide out through the button's edge. `TextMorph` does the same for any text that changes in place.

Actions that can be taken back right after (sending) give a short undo window on the button itself: the label morphs to "Undo" and the outline drains for the length of the window (`<Button countdown={5000}>`). Clicking again cancels. When the outline is empty the action happens and the button confirms as above.

Destructive actions that can't be undone are held, not clicked (`<Button hold={1200}>`): the button fills from the left while held, runs back when let go early, and only acts when full. A plain tap shows a hint ("Hold to delete"). Space and Enter can be held too. Longer labels crossfade instead of morphing (`fade`). Toasts are for things that can be undone or happened elsewhere.

## Mail

- **Rows** show sender, subject and snippet on one line, the date on the right (time today, weekday this week, date before). Unread is a dot plus semibold, nothing louder. On hover the date crossfades into archive, snooze and delete; on touch a row swipes (left archive, right snooze). Resting on the sender's name brings up a card with their name and address (copy it) and, where the app has them, Write and All messages.
- **Selection** works like a file list. A row's whole left edge (not just its checkbox) toggles it, and dragging from there gives every row passed the same state, so starting on a selected row deselects. Shift selects a range from the last row, ⌘/Ctrl-click toggles one, X the focused row, ⌘A all, Escape clears. Neighbouring selected rows share one background that grows and shrinks with the run. A bar with bulk actions rises from the bottom.
- **Snooze** offers a few times that make sense right now and a field that understands "tomorrow 3pm".
- **Threads** keep older messages collapsed and fold long middles into "3 earlier messages". Opening one grows it in a single motion while the body fades in from under the snippet it replaces; closing runs the same way back. Quoted history hides behind "•••".
- **HTML mail** renders sanitized in a sandboxed frame without scripts, on a light card in both themes. Remote images stay hidden behind a quiet notice until allowed, and then load through the image proxy.
- **The composer** reveals Cc and Bcc on demand, takes files dropped anywhere on it, sends with an undo window and can schedule.
- **Frame** (`AppShell`): sidebar and header are one sunken surface without a dividing line; the content sits in it as a paper panel with a rounded corner (`xl`) where header and sidebar meet. The header is as tall as the account picker, so search and picker line up.
- **Navigation:** one sliding highlight marks the current folder; label tags are the only extra color; the account picker is a select (see above) showing the current account; search turns `from:` and friends into chips; `?` lists every shortcut.

## Icons

Lucide on the web, SF Symbols on Apple, 16px, stroke 1.75. An icon sits next to a word or replaces one in a toolbar with a tooltip. Never decorate with icons.

## Don't

- Icons in tinted squares or circles
- Cards with a colored stripe on one side
- Gradient text, glass effects, glow
- Emoji in UI copy
- Counters and stats as decoration
- Exclamation marks, "Welcome back!", "Oops!"
- Skeleton screens for things that load in under 300 ms
- Restyling library components from the outside, add a variant instead

## Copy

Sentence case. Buttons say what happens ("Archive", "Send later"), toasts confirm it ("Archived", with Undo). Errors say what went wrong and what to do next, no apologies.

## Code

Components live in `packages/ui` (Apache-2.0) on top of Base UI. Tokens live in `packages/ui/src/styles.css`. Apps import both and never define their own colors, radii or shadows. `bun run lint` enforces this through `@shadcn/lint`.
