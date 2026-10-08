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

Raw Tailwind colors don't exist in this project (the default palette is removed), so `bg-blue-500` won't compile into anything.

## Type

Figtree on the web, SF Pro on Apple. Base size is 14px, the app is dense but not cramped.

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

Radius `sm` 6, `md` 8, `lg` 12. Inputs and buttons use `md`, popups `lg`. Borders separate, shadows only lift things that float (`shadow-pop`, `shadow-dialog`). Never both a heavy border and a shadow on the same element.

## Motion

120 to 200 ms, ease-out, enter slightly faster than exit. Popups fade and scale from 98%, dialogs from 96%. Nothing animates on page load. `prefers-reduced-motion` turns everything into instant changes.

Loading buttons darken and a short segment of their outline runs around them (`<Button loading>`). The segment grows in over about 450 ms and shrinks out in about 150 ms. The button stays where it is, keeps its label and ignores further clicks. With reduced motion the full outline shows instead. Spinners are for things that aren't buttons.

Checkboxes give slightly under the finger, and their check strokes itself in from left to right (about 180 ms).

Calendars page with a short fade-through: the old month fades out almost in place, the new one fades in from the paging direction once the old one is gone, so dates never overlap. The month name crossfades while the year stays put. Month and year each open a list around themselves (all months, three years either side) and also take typing: what you type shows in the header and highlights the first match, Enter takes it or a typed value outside the list (a year like 1850, a month number). Today has a dot, the week starts on the user's regional first day, and picking a date closes the picker.

Text fields draw their own caret: it glides to the next character (90 ms) instead of jumping, stays solid while typing and only blinks once you pause. Email and number fields keep the native caret because browsers don't report its position there.

When an action needs confirming, the button turns green for about 1.5 s and its label morphs into the past tense with a check in front (`<Button success="Saved">`): letters both words share stay and glide, the rest fades. The button keeps its size, so nothing around it moves: pass every label it can show (`labels={["Undo", "Sent"]}`) and it sizes to the widest. Leaving letters travel with their neighbours and slide out through the button's edge. `TextMorph` does the same for any text that changes in place.

Actions that can be taken back right after (sending) give a short undo window on the button itself: the label morphs to "Undo" and the outline drains for the length of the window (`<Button countdown={5000}>`). Clicking again cancels. When the outline is empty the action happens and the button confirms as above.

Destructive actions that can't be undone are held, not clicked (`<Button hold={1200}>`): the button fills from the left while held, runs back when let go early, and only acts when full. A plain tap shows a hint ("Hold to delete"). Space and Enter can be held too. Longer labels crossfade instead of morphing (`fade`). Toasts are for things that can be undone or happened elsewhere.

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
