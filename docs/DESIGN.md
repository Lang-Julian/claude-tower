# claude-tower — design system

## Aesthetic

"What if Jony Ive designed Destiny's HUD."

- **Deep space substrate.** Near-black with a subtle mesh gradient. Never pure `#000`.
- **Liquid glass panels.** Cards, modals, HUD are translucent layers with `backdrop-filter` blur + saturation. Like visionOS / macOS Sequoia, not like cheap glassmorphism tutorials.
- **Geometric clarity.** Sharp 8px corners, hairline borders (`1px rgba(255,255,255,0.08)`), strict grid alignment.
- **Light as material.** Status communicated by *glow* — a soft outer ring that pulses with state, not just a colored dot.
- **Motion with physics.** Everything that moves uses a single easing curve (Apple's standard). Springs for interactive feedback (button press, card lift). Nothing snaps; nothing lingers.
- **Pixel charm reserved.** The Town view keeps its 8-bit characters and houses (it's an in-joke and it works). Only the *chrome* around the town gets the new aesthetic.

## Color tokens (CSS vars in `theme.css`)

| token | value | use |
|---|---|---|
| `--bg-0` | `#06070d` | page base |
| `--bg-1` | `#0a0c14` | first surface |
| `--bg-2` | `#10131f` | nested surface |
| `--glass-fill` | `rgba(255,255,255,0.04)` | card body |
| `--glass-fill-hover` | `rgba(255,255,255,0.07)` | card hover |
| `--glass-border` | `rgba(255,255,255,0.08)` | card hairline |
| `--glass-border-strong` | `rgba(255,255,255,0.14)` | active/focus border |
| `--text-1` | `#f5f6fa` | primary |
| `--text-2` | `#9ba1b3` | secondary |
| `--text-3` | `#5a6075` | tertiary / disabled |
| `--accent` | `#6e7bff` | primary action (electric indigo) |
| `--accent-2` | `#00d4ff` | secondary highlight (cyan) |
| `--status-thinking` | `#00d4ff` | cyan pulse |
| `--status-input` | `#ffb84d` | amber pulse |
| `--status-permission` | `#ff5a5f` | red-orange pulse |
| `--status-active` | `#2ecc71` | green |
| `--status-idle` | `#6b7080` | gray |
| `--status-stopped` | `#3a3f52` | dim gray |

## Typography

| token | font | weight | use |
|---|---|---|---|
| `--font-display` | `"Inter", system-ui` | 700 | titles, hero |
| `--font-body` | `"Inter", system-ui` | 500 | UI text |
| `--font-mono` | `"JetBrains Mono", "SF Mono", monospace` | 400 | pids, paths, code |
| `--font-pixel` | `"Press Start 2P", monospace` | 400 | town characters only |

Inter via Google Fonts is already an OK trade-off (small font, ubiquitous). JetBrains Mono via Google Fonts too.

## Motion

| token | value | use |
|---|---|---|
| `--ease` | `cubic-bezier(0.25, 0.1, 0.25, 1)` | default everything |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | button press, card lift |
| `--ease-decel` | `cubic-bezier(0, 0, 0.2, 1)` | enter animations |
| `--dur-fast` | `120ms` | hover, focus |
| `--dur-base` | `220ms` | state change |
| `--dur-slow` | `420ms` | layout, drawer slide |

Pulse keyframe: 1.6s `infinite` for status glow.

## Layering / depth

- Z-index scale: `--z-base: 0`, `--z-card: 1`, `--z-hud: 10`, `--z-modal: 100`, `--z-toast: 1000`.
- Card shadow: layered for depth (rim + drop). See `--shadow-card`.
- HUD shadow: more pronounced, hint at floating: `--shadow-hud`.

## Component principles

- **Cards** are containers, never decorative. No gradients inside cards. The *outside* of the card (the page) carries gradient and texture.
- **Buttons** have three states (rest, hover, press) with spring on press. Approve = green outline + green text; Deny = red outline + red text. Filled buttons only for primary action on the page.
- **Status orb** = colored disc + radial gradient halo + animated pulse keyframe when active. `<span class="orb" data-status="thinking"></span>`.
- **Sparkline** is SVG, 60×16, with a soft gradient fill and a 2px stroke. The last bucket gets a 3px stroke and a 4px halo dot.
- **Approval bar** lifts out of the card on a Y-axis spring when a pending approval appears. Stays in-DOM (no layout jump).

## Don't

- No gradients inside text. No rainbow accents.
- No card-stacking shadows from 2014.
- No emoji as status icon (we use glyphs + glow).
- No drop-shadow on text.
- No more than two accents on screen simultaneously.

## A11y baseline

- All interactive elements reachable by keyboard.
- Focus ring: 2px outer ring of `--accent`, offset 2px.
- `prefers-reduced-motion`: kill pulse, kill spring, keep `--dur-base` for state changes.
- Color contrast on text vs glass: tested at `--text-1` over `--glass-fill` over `--bg-1` — passes WCAG AA.
