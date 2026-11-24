---
name: Nexus
description: A home control deck on a desk tablet, with chunky outlined controls and big readouts in a neobrutalist style.
colors:
  nexus-green: "#3ddc84"
  paper: "light-dark(#fdf3dc, #111111)"
  panel: "light-dark(#ffffff, #1c1c1c)"
  highlight-panel: "light-dark(#fff4b8, #2b2716)"
  ink-line: "light-dark(#000000, #f2ead3)"
  ink: "light-dark(#111111, #f7f3e8)"
  ink-dim: "light-dark(#4a4a4a, #b8b0a0)"
  ok: "light-dark(#0a6b35, #3ddc84)"
  warn: "light-dark(#a35200, #ffb703)"
  bad: "light-dark(#e5383b, #ff5a5f)"
typography:
  display:
    fontFamily: "ui-rounded, system-ui, sans-serif"
    fontSize: "clamp(4rem, min(15vw, 34vh), 12rem)"
    fontWeight: 900
    lineHeight: 1
    fontFeature: "tnum"
  headline:
    fontFamily: "ui-rounded, system-ui, sans-serif"
    fontSize: "clamp(1.1rem, 5vh, 2rem)"
    fontWeight: 700
  reading:
    fontFamily: "ui-rounded, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 900
    fontFeature: "tnum"
  title:
    fontFamily: "ui-rounded, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
  body:
    fontFamily: "ui-rounded, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
  label:
    fontFamily: "ui-rounded, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "48px"
  button-accent:
    backgroundColor: "{colors.nexus-green}"
    textColor: "#000000"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "48px"
  card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "16px"
  reading-tile:
    backgroundColor: "{colors.highlight-panel}"
    textColor: "{colors.ink}"
    typography: "{typography.reading}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "48px"
  nav-item-active:
    backgroundColor: "{colors.nexus-green}"
    textColor: "#000000"
    rounded: "{rounded.md}"
    size: "48px"
---

# Design System: Nexus

## Overview

**Creative North Star: "The Control Deck"**

Nexus is a sturdy hardware panel for a home: clear switches, status lamps and big readouts, read from a seat away
and tapped in passing. Every surface is a slab with a thick ink outline and a hard offset shadow, as if cut from
board and screwed onto the desk. Controls are chunky and clicky. They stand proud of the panel and press flat when
tapped, so a tap feels like pushing a real button.

The deck has two equal finishes. **Cream paper** has black ink outlines. **Near-black** has bone-coloured outlines.
Every colour is a `light-dark()` pair, so a screen is designed once and must read just as well in both themes. One
colour carries the identity: Nexus Green, on the logo, the active page, the play button and every healthy status
lamp. Everything else is ink, paper and three status colours.

Density is low on purpose. The clock and the readings are the largest things on screen, the status strip is a row of
lamps, and a healthy day reads as calm. It must never slide into the generic admin-panel look of thin grey hairlines
and small text, and it must never go soft: no blur, no glass, no gradients.

**Key Characteristics:**
- 3px ink outlines on every surface and control. Weight is the structure.
- Hard offset shadows with no blur (6px on cards, 4px on controls). They are the only source of depth.
- Pressing a control moves it into its shadow (4px down and right, shadow gone) in 75ms.
- One brand colour (Nexus Green) plus paper, ink and status colours, every one defined for both themes.
- Heavy rounded system type with tabular figures, and huge readouts for distance reading.
- Touch targets of 48px or more everywhere.

## Colors

A two-finish palette: every neutral is a `light-dark()` pair of cream paper with black ink and near-black with bone
ink. Nexus Green is the same in both.

### Primary
- **Nexus Green**: the brand colour. Used for the tilted Nexus logo plate, the active nav button, primary and
  toggled-on buttons (play, like, shuffle on, the selected tab), healthy status lamps, and the fill of meter bars. Text
  on it is always pure black, in both themes.

### Neutral
- **Paper**: the page background behind every panel. Warm cream, or near-black.
- **Panel**: card, button and input surfaces. White, or a lifted charcoal.
- **Highlight Panel**: the tile colour for readings and the forecast: pale butter, or a dark olive. It marks
  "this is a value to read" inside a card.
- **Ink Line**: every outline and every shadow. Pure black, or bone.
- **Ink**: primary text.
- **Ink Dim**: secondary text: labels, units, dates, timestamps, captions.

### Status
- **OK**: deep green on paper and the brand green on dark. For text that confirms ("Connected").
- **Warn**: burnt orange, or amber. Degraded but working.
- **Bad**: red. Errors, down hosts and stopped containers, the "server unreachable" banner (white bold text on it),
  and alert text.

### Named Rules
**The Two Finishes Rule.** Every colour is declared as `light-dark(paper, dark)` in the `@theme` block in
`apps/web/src/index.css`, and nowhere else. A colour written for one theme only is a bug.

**The Ink Draws Everything Rule.** Outlines and shadows use Ink Line, never a tint, grey or transparent black. A
border that has to be quieter gets thinner (2px, as on lamps and bars), not lighter.

**The Lamp Rule.** A status is a round lamp with an ink ring: green for healthy, red for a problem, Ink Dim for
unknown or not set up. Never colour alone: the lamp always has a text label next to it.

## Typography

**Display Font:** the system rounded face (`ui-rounded`), falling back to `system-ui` and sans-serif
**Body Font:** the same
**Label Font:** the same

**Character:** One rounded system family, used at extremes of weight: black (900) for things to read from across the
room, bold (700) for controls, and regular for supporting text. No web fonts: everything comes from the device,
which keeps the page local and private.

### Hierarchy
- **Display**: the dashboard clock. It scales with the viewport and is always tabular.
- **Ambient clock** (300, `min(28vw, 40vh)`, white on pure black): the full-screen clock mode, and the timer at
  `min(20vw, 30vh)`. A light weight is used on purpose for a large glowing figure in a dark room.
- **Headline**: the date under the clock, in Ink Dim.
- **Reading**: values in reading tiles (Outside, Room), always tabular, unit included.
- **Title**: card headings ("Raspberry Pi", "Containers", "VPS").
- **Body**: list rows, track names and settings text. Medium (500) in inputs, bold (700) on buttons.
- **Label**: captions, metadata and secondary values, almost always in Ink Dim. Extra small (0.75rem) only for the
  third line of a dense tile, never for something you need to read.

### Named Rules
**The Tabular Rule.** Anything that changes while you watch (clock, timer, progress times, temperatures, percentages)
uses tabular figures, so digits never shift.

**The Weight Not Size Rule.** Inside a card, hierarchy comes from weight (900 against 400) and from Ink against Ink
Dim before size. Small grey type is for metadata only.

## Layout

The app shell has a status bar on top: the Nexus logo plate on the left and the lamp row on the right, which opens
Homelab when tapped. The main navigation is a column of square 48px icon buttons. In landscape it sits as a vertical
rail on the left, centred. In portrait it becomes a bottom bar spread across the width. The content area scrolls on
its own, and the shell never scrolls.

Pages are grids of cards with gaps of 8px to 12px. The dashboard in landscape is two columns at 3:2: the clock card
fills the tall left column, and the right column stacks Now Playing, the readings and the shortcuts, scrolling if
needed. In portrait, everything stacks in a single column. Card padding is 16px and the spacing scale is
4/8/12/16/24px. Large type sizes use `clamp()` against both `vw` and `vh`, so the clock fits on a short landscape
tablet and on a tall phone.

**The Kiosk First Rule.** Design at a landscape tablet (1280×800) first, then check a phone (390px wide) and a laptop.
Nothing may need hover. Nothing may scroll sideways.

## Elevation & Depth

Depth is entirely structural. Hard offset shadows in Ink Line with zero blur make every surface look like a slab
lifted off the paper. There is no ambient shadow, no blur and no tonal layering. Elevation means "this is a thing"
(a card, a control), not "this is above that".

### Shadow Vocabulary
- **Slab** (`box-shadow: 6px 6px 0 var(--color-line)`): every card.
- **Key** (`box-shadow: 4px 4px 0 var(--color-line)`): buttons, nav items, the logo plate on the login screen, and
  reading tiles.
- **Badge** (`box-shadow: 3px 3px 0 var(--color-line)`): the small logo plate in the header.
- **Pressed** (`box-shadow: none; transform: translate(4px, 4px)`): a button while held. It moves exactly into its
  shadow.

### Named Rules
**The Hard Shadow Rule.** Shadows are solid ink, offset down and to the right, with 0 blur. Never `blur`,
`backdrop-filter`, `drop-shadow` or gradients.

**The Press Rule.** Anything with a Key shadow is a control and must press into it on `:active` (75ms). Anything
that does not press does not get a Key shadow.

## Shapes

Gently rounded slabs. Cards use 12px corners, buttons, inputs and tiles 8px, album art 6px, and lamps and meter
tracks are fully round. All corners on one element share the same radius. The one deliberate break is the Nexus logo
plate: square-cornered and tilted by -2°, like a label stuck on the panel. Nothing else is rotated.

## Components

### Buttons
Chunky and clicky. Each one is a raised key that pushes in when tapped.
- **Shape:** gently rounded (8px), 3px ink outline, at least 48×48px.
- **Default:** a Panel background, Ink text in bold, 16px horizontal padding, a Key shadow. Icon-only buttons are
  square, with a 24px stroked icon.
- **Accent:** a Nexus Green background with black text. Used for the primary action (play, log in), the selected tab,
  and toggles that are on (`aria-pressed`).
- **Pressed:** moves 4px down and right and loses its shadow, in 75ms. With reduced motion turned on, the transition
  is off and the state still changes.
- **Focus:** a 3px dashed ink outline, 3px outside the button.
- **Disabled:** the native disabled state. It keeps its outline.

### Cards / Containers
- **Corner Style:** 12px.
- **Background:** Panel.
- **Shadow Strategy:** Slab (see Elevation & Depth).
- **Border:** 3px Ink Line.
- **Internal Padding:** 16px. The title sits on the first row, often with an Ink Dim note after it ("snapshot 14s
  old").

### Inputs / Fields
- **Style:** a Panel background, 3px ink outline, 8px corners, 48px high, medium weight.
- **Focus:** the same 3px dashed ink outline as buttons.
- **Error:** a Bad-coloured message below the field, with `role="alert"`.
- **Range sliders:** native, tinted Ink and 48px high for a thumb-sized hit area.

### Navigation
- **Style:** square 48px icon keys with a Key shadow, in a vertical rail in landscape and a bottom bar in portrait.
- **Active:** the Accent key (Nexus Green), marked with `aria-current`. Each key has an `aria-label` and a `title`.

### Status Lamp (signature)
A round dot (12px in the header, 10px in lists) with a 2px ink ring. It is filled Nexus Green when healthy, Bad when
not, and Ink Dim when unknown, and always has a text label next to it. The header's row of lamps is one big button
that opens Homelab.

### Reading Tile (signature)
A Highlight Panel tile with a 3px outline, 8px corners and a Key shadow. It shows a label in Ink Dim, a value in the
Reading style, and an optional bold note below ("Partly cloudy"). Used for Outside and Room, and, without the shadow,
for the forecast days under the clock.

### Meter Bar
A 12px fully-round track with a 2px ink ring and a Panel inside, filled Nexus Green to the value. The label sits
above on the left and the value on the right (CPU, RAM, Disk, song progress).

## Do's and Don'ts

### Do:
- **Do** outline every surface and control at 3px in Ink Line, and give cards the 6px Slab shadow and controls the
  4px Key shadow.
- **Do** make every control at least 48×48px, and give it the press-in `:active` state.
- **Do** define every new colour as a `light-dark()` pair in `@theme`, and check the screen in both themes before
  calling it done.
- **Do** put Nexus Green on the identity and on on, active or healthy states, with black text on it.
- **Do** make readouts big, heavy and tabular, and keep secondary text in Ink Dim at body or label size.
- **Do** show a missing integration as a hidden card or plain "not set up" text, never as an error.

### Don't:
- **Don't** use blurred shadows, glass or `backdrop-filter`, gradients, or soft elevation. Depth is hard ink shadows
  only.
- **Don't** build the generic admin-panel look: thin grey 1px borders, small dense tables, light grey text on white.
- **Don't** use colour alone for status. A lamp always has a text label.
- **Don't** load web fonts, icon fonts or anything from a CDN. Fonts are the system rounded face and icons are inline
  SVG paths.
- **Don't** rotate anything except the Nexus logo plate.
