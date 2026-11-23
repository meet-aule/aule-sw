---
version: alpha
name: Aule
description: One design for every Aule product. Paper, ink and one accent, set in Inter. Tokens without a prefix are the web (demo, parents' page, store); `eink-` is the 7.5 inch device screen and `esp32-` the small colour screen.
colors:
  paper: "#f5f2ea"          # the page: warm white, "paper and ink"
  paper-deep: "#ece8dc"     # hover of quiet buttons, the flat shadow of cards
  surface: "#fbfaf6"        # cards, fields and messages, a warm white on the paper
  primary: "#141414"        # the ink: text and strong borders
  muted: "#6b6b6b"          # secondary text and notes
  line: "#c9c3b4"           # soft borders and dividers
  accent: "#9a5b2e"         # THE accent, worked copper. Change this one line to repaint every product, then run `pnpm design-derive` and `pnpm design-tokens`
  accent-tint: "#e6dacc"    # derived: accent at 16% over paper. Background of the quiet button and of highlights
  accent-deep: "#744423"    # derived: accent at 75% over black. Text on accent-tint and the hover of the filled button
  on-accent: "#ffffff"      # text on an accent background
  danger: "#8f1d14"         # errors and destructive actions
  tile: "#14130f"           # video and tutor tiles of the playground
  tile-ink: "#f6f4ef"       # text on the dark tiles
  board: "#ffffff"          # what the tutor draws: always black on white, like the device screen
  device-frame: "#1b1b1b"   # the 14px frame of the device screen in the playground
  eink-black: "#000000"     # the four levels of the device panel: 0, 85, 170 and 255
  eink-dark-grey: "#555555"
  eink-light-grey: "#aaaaaa"
  eink-white: "#ffffff"
  esp32-black: "#000000"    # small colour screen: black background,
  esp32-white: "#ffffff"    # white text
  esp32-accent: "#e8a26b"   # and one accent: the light version of the copper, for a dark background
  esp32-white-70: "#ffffffb3" # white at 70%: the text of a disabled button (10:1 on black)
  esp32-disabled: "#707070" # ONLY the dashed border of a disabled button: 4.2:1 on black as a graphic, over the 3:1 of WCAG 1.4.11
typography:
  display:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: 4rem          # the hero heading, 64/64, desktop. Inter's optical size turns itself into Inter Display above 32px
    fontWeight: 700
    lineHeight: 64px
    letterSpacing: -0.033em
  display-sm:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: 2.625rem      # the hero heading on a phone, 42/48
    fontWeight: 700
    lineHeight: 48px
    letterSpacing: -0.033em
  headline:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: 3.375rem      # a section heading, 54/56, desktop
    fontWeight: 700
    lineHeight: 56px
    letterSpacing: -0.035em
  headline-sm:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: 2rem          # a section heading on a phone, 32/40, and the title of an app page
    fontWeight: 700
    lineHeight: 40px
    letterSpacing: -0.023em
  lead:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: 1.25rem       # the paragraph under a heading, 20/28, desktop
    fontWeight: 400
    lineHeight: 28px
    letterSpacing: -0.00625em
  card-title:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: 1.375rem      # a card or a form title, 22/28
    fontWeight: 700
    lineHeight: 28px
    letterSpacing: -0.0114em
  body:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: 1rem          # text, 16/24. It is also the lead on a phone
    fontWeight: 400
    lineHeight: 24px
  body-tabular:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: 1rem          # the session clock: same as body, with figures of one width
    fontWeight: 400
    lineHeight: 24px
    fontFeature: "tnum"
  small:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: 0.875rem      # notes, captions and the footer, 14/20
    fontWeight: 400
    lineHeight: 20px
  label:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: 0.875rem      # field labels, 14/20
    fontWeight: 500
    lineHeight: 20px
  button:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: 1rem          # the large button, 16/24
    fontWeight: 500
    lineHeight: 24px
  button-sm:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: 0.875rem      # the small button, 14/20
    fontWeight: 500
    lineHeight: 20px
  eink-title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 34px          # device screen: title, Semi Bold 34/40
    fontWeight: 600
    lineHeight: 40px
  eink-body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 22px          # device screen: text, Regular 22/30
    fontWeight: 400
    lineHeight: 30px
  eink-option:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 24px          # device screen: the label of an option or a button, Semi Bold 24/30
    fontWeight: 600
    lineHeight: 30px
  eink-small:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 18px          # device screen: the smallest text there is, 18/24
    fontWeight: 400
    lineHeight: 24px
  esp32-title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 48px          # small colour screen (480x480 in 38.4 mm, about 314 ppi), looked at from close: title 48/60
    fontWeight: 600
    lineHeight: 60px
  esp32-body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 40px          # text 40/50
    fontWeight: 400
    lineHeight: 50px
  esp32-button:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 40px          # the label of a button, 40/50; the small button is esp32-min
    fontWeight: 600
    lineHeight: 50px
  esp32-min:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 32px          # the smallest text there is: 2.6 mm
    fontWeight: 400
    lineHeight: 40px
rounded:
  xs: 3px                   # the microphone level bar
  sm: 6px                   # the caption over a video
  md: 8px                   # buttons, fields and notices
  lg: 12px                  # tiles, messages and chips
  xl: 16px                  # cards, the tutor's board
  full: 9999px              # the orb and round marks. Buttons are not pills
  esp32-md: 24px            # small colour screen: the radius of a button, 24 px, the same 2 mm as the web's 8px. Fixed
spacing:
  2xs: 4px                  # vertical padding of the small button
  xs: 8px                   # between buttons, between small items
  sm: 12px                  # vertical padding of the large button
  md: 16px                  # between a heading and its paragraph, between the fields of a form
  lg: 24px                  # side margin of the page and between cards
  xl: 32px                  # padding of a card
  2xl: 48px                 # between blocks inside a section
  3xl: 96px                 # between sections on desktop (64px on a phone)
  text-column: 640px        # widest a paragraph gets: 60 to 75 characters a line
  container: 1128px         # widest the page gets (1080 of it is content)
  eink-margin-x: 40px       # device screen: side margins
  eink-margin-y: 32px       # device screen: top and bottom margins
  eink-gap: 24px            # device screen: between two things that can be pressed
  eink-air: 64px            # device screen: around the one action of a screen
  eink-border: 2px          # device screen: the stroke of buttons and fields
  eink-button-height: 56px  # device screen: the drawn button
  eink-touch: 72px          # device screen: the area that answers a press
  esp32-xs: 8px             # small colour screen: scale of its own, on a base of 4
  esp32-sm: 16px
  esp32-md: 24px
  esp32-lg: 32px
  esp32-target: 150px       # the least a press target measures: 12 mm
  esp32-target-gap: 38px    # the least air between two press targets: 3 mm
  esp32-stroke: 4px         # the line of a button's border
components:
  page:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.primary}"
    typography: "{typography.body}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 12px
  button-primary-sm:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.button-sm}"
    rounded: "{rounded.md}"
    padding: 4px
  button-primary-hover:
    backgroundColor: "{colors.accent-deep}"
    textColor: "{colors.on-accent}"
  button-secondary:
    backgroundColor: "{colors.accent-tint}"
    textColor: "{colors.accent-deep}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 12px
  button-secondary-hover:
    backgroundColor: "{colors.paper-deep}"
    textColor: "{colors.accent-deep}"
  button-link:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.accent}"
    typography: "{typography.button}"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 12px
  button-talk-active:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.xl}"
    padding: "{spacing.xl}"
  card-note:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    typography: "{typography.small}"
    rounded: "{rounded.xl}"
    padding: "{spacing.md}"
  highlight:
    backgroundColor: "{colors.accent-tint}"
    textColor: "{colors.accent-deep}"
    rounded: "{rounded.md}"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 12px
  field-border:
    backgroundColor: "{colors.line}"
  note:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.muted}"
    typography: "{typography.small}"
  notice-error:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.danger}"
    typography: "{typography.small}"
    rounded: "{rounded.md}"
  message-tutor:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.lg}"
  message-you:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  video-tile:
    backgroundColor: "{colors.tile}"
    textColor: "{colors.tile-ink}"
    rounded: "{rounded.lg}"
  board:
    backgroundColor: "{colors.board}"
    textColor: "{colors.primary}"
    rounded: "{rounded.xl}"
  device-screen:
    backgroundColor: "{colors.device-frame}"
    textColor: "{colors.board}"
    rounded: 10px
  skip-link:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.paper}"
  eink-screen:
    backgroundColor: "{colors.eink-white}"
    textColor: "{colors.eink-black}"
    typography: "{typography.eink-body}"
  eink-button:
    backgroundColor: "{colors.eink-white}"
    textColor: "{colors.eink-black}"
    typography: "{typography.eink-option}"
    rounded: "{rounded.md}"
    height: "{spacing.eink-button-height}"
  eink-divider:
    backgroundColor: "{colors.eink-light-grey}"
  eink-button-primary:
    backgroundColor: "{colors.eink-black}"
    textColor: "{colors.eink-white}"
    typography: "{typography.eink-option}"
    rounded: "{rounded.md}"
    height: "{spacing.eink-button-height}"
  eink-note:
    backgroundColor: "{colors.eink-white}"
    textColor: "{colors.eink-dark-grey}"
    typography: "{typography.eink-small}"
  esp32-screen:
    backgroundColor: "{colors.esp32-black}"
    textColor: "{colors.esp32-white}"
    typography: "{typography.esp32-body}"
  esp32-button:
    backgroundColor: "{colors.esp32-accent}"
    textColor: "{colors.esp32-black}"
    typography: "{typography.esp32-button}"
    rounded: "{rounded.esp32-md}"
    height: "{spacing.esp32-target}"
  esp32-button-small:
    backgroundColor: "{colors.esp32-accent}"
    textColor: "{colors.esp32-black}"
    typography: "{typography.esp32-min}"
    rounded: "{rounded.esp32-md}"
    height: "{spacing.esp32-target}"
  esp32-button-disabled:
    backgroundColor: "{colors.esp32-black}"
    textColor: "{colors.esp32-white-70}"
    typography: "{typography.esp32-button}"
    rounded: "{rounded.esp32-md}"
    height: "{spacing.esp32-target}"
  esp32-button-disabled-stroke:
    backgroundColor: "{colors.esp32-black}"
    textColor: "{colors.esp32-disabled}"
  esp32-title:
    backgroundColor: "{colors.esp32-black}"
    textColor: "{colors.esp32-white}"
    typography: "{typography.esp32-title}"
---

## Overview

One design for every Aule product: the demo and the parents' page (`aule-sw`), the store (`aule-store`), the device screen and the small colour screen. It looks like paper and ink with a single accent, and it reads calmly, like a tool and not like a toy. Every heading, the tutor's words and the interface are set in Inter. The only drawing of letters that is not Inter is the "Aule" logotype, which is a fixed drawing, not text.

This file is the original. `aule-store` carries an identical copy that a check keeps honest. The CSS and the Figma variables are generated from it (`pnpm design-tokens`), and CI fails if a generated file does not match.

The scale of type, buttons and spacing was measured on `academy.notion.com` (CSS read on 23 Nov 2026). Only sizes, weights, air and radii are taken; no logo, text, illustration or blue of anyone else's.

Figma: <https://www.figma.com/design/yOAIYJNl5nZ7NgWtESN0Fo>.

## Modes

The format has no modes, so a mode is a prefix on the token name.

| Mode | Where | Tokens |
|---|---|---|
| `web` | the demo and the parents' page (`aule-sw`), the store (`aule-store`) | no prefix |
| `eink` | the 7.5 inch device screen, 800 x 480, four greys | `eink-` |
| `esp32` | the small colour screen, 480 x 480 in 38.4 mm (about 314 ppi) | `esp32-` |

`eink` uses only the four levels of grey. `esp32` does not use the `web` palette: it is a black background, white text and one accent, `#e8a26b`, the light version of the copper for a dark background. Its type scale is its own, because it is looked at from close and a conversion from `eink` does not fit in 480 px: nothing below 32 px (2.6 mm), body 40, title 48, buttons 32 to 40 and press targets of 150 px or more (12 mm). Between two targets there are at least 38 px (3 mm, `esp32-target-gap`). A button has a 4 px border (`esp32-stroke`) and a radius of 24 px, the same 2 mm as the web's. A disabled button has its text in white at 70 % (`esp32-white-70`) and a dashed border in `esp32-disabled` (#707070), a grey that is used for nothing else: it is 4.2:1 on black, which is a graphic and has to reach 3:1 (WCAG 1.4.11), not the 4.5:1 of text. The rest of its type scale is a proposal until it is tried on the real screen.

| | `web` | `eink` | `esp32` |
|---|---|---|---|
| Letter | Inter, the scale of Typography | Inter: titles Semi Bold 34/40, text 22/30, options Semi Bold 24, 18 at the least | Inter with its own scale |
| Line height of text | 1.5 | 1.35 to 1.4 | 1.25 |
| Negative tracking on big headings | yes | no | no |
| Button | radius 8, weight 500, padding 12 x 20 | radius 8, 2 px border, 56 px high, 72 px of touch area | accent background with black text, 4 px border, radius 24, target of 150 px or more, 38 px between targets |
| Spacing | the whole scale, 4 to 96 | 4 to 64: margins of 40 and 32, 24 between targets | its own scale on a base of 4 |
| Colour and shadows | paper, ink, one accent, no shadows | four greys | black background, white text and the accent `#e8a26b` |

## Colors

Paper (`paper`, `paper-deep`, `surface`), ink (`primary`, `muted`, `line`) and **one** accent. The accent is `accent`; `accent-tint` and `accent-deep` are the same colour made lighter and darker, so that the quiet button, the highlight and the hover keep their contrast. They are derived: when `accent` changes, run `pnpm design-derive` and it rewrites those two lines. A test fails if they have drifted.

`danger` is for errors and what cannot be undone. `tile`, `tile-ink`, `board` and `device-frame` belong to the playground's video tiles and device screen. The `eink-` colours are the four levels of the panel; the `esp32-` colours are black, white and the accent `#e8a26b`, and the screen does not use the paper, the ink or the copper.

The recommendation for the accent is copper `#9a5b2e` on paper `#f5f2ea`; it is what the Figma and the demo already used. The store's orange `#cf5a1e` on `#faf7f2` goes away.

## Typography

Inter, self-hosted (the official variable WOFF2 of Inter 4.1, with its OFL licence next to it). No font comes from another domain. Inter 4 has an optical-size axis: the browser sets it from the font size (`font-optical-sizing: auto`), so type above 32 px is Inter Display without a second font.

Texts are 1.5 tall (24 px on 16) and headings 1.0 to 1.05, with negative tracking on the big ones. Few sizes, always the same: 64, 54, 42, 32, 22, 20, 16 and 14.

| Use | Desktop | Phone | Weight |
|---|---|---|---|
| Hero heading | `display` 64/64 | `display-sm` 42/48 | 700 |
| Section heading | `headline` 54/56 | `headline-sm` 32/40 | 700 |
| Lead | `lead` 20/28 | `body` 16/24 | 400 |
| Card or form title | `card-title` 22/28 | the same | 700 |
| Text | `body` 16/24 | the same | 400 |
| Small | `small` 14/20 | the same | 400 |

In the apps (the playground), the page title is `headline-sm` and a form title is `card-title`.

## Layout

A page is at most `container` wide, with `lg` on each side. A paragraph is at most `text-column` wide. Sections are `3xl` apart on desktop and 64 px on a phone; blocks inside a section are `2xl` apart; a heading and its paragraph are `md` apart. The scale is on a base of 4: `2xs` 4, `xs` 8, `sm` 12, `md` 16, `lg` 24, `xl` 32, `2xl` 48, `3xl` 96. Other isolated values (2, 6, 10 and 14 px, and the 20 px at the sides of a button) stay in the CSS and are not tokens.

## Elevation & Depth

None. No soft shadows: separation comes from `line` borders, from `paper-deep` and from air. The form card and the board keep a flat shadow in `paper-deep` as a drawn edge, not a blur.

## Shapes

Radius 8 for buttons, fields and notices; 12 for tiles and messages; 16 for cards. A button is never a pill. `full` is for the orb and round marks.

## Components

- **Buttons.** A rectangle with radius 8, a 1 px transparent border and weight 500. Large: 16/24 with 12 x 20 padding. Small: 14/20 with 4 x 14 padding and 34 px of height. Primary is `accent` with `on-accent` text; quiet is `accent-tint` with `accent-deep` text and no border; the link is `accent` text with an arrow (`Find answers →`) and no background. Buttons are 8 px apart.
- **Every pair of text and background above must reach 4.5:1.** `pnpm --filter @aule/design test` walks them one by one. A component whose name ends in `-stroke` is a graphic, not text (a border, an icon): its `textColor` is the line, its `backgroundColor` is what it is drawn on, and it has to reach 3:1 (WCAG 1.4.11). A colour with transparency (`#ffffffb3`) is laid over its background before it is measured. The linter of the CLI measures every pair as text and so warns once, about `esp32-button-disabled-stroke`; the test allows that one warning and no other.
- **Fields** are `surface` with a 1.5 px `line` border and radius 8; the focus ring is 3 px of ink with 2 px of offset.
- **The device screen** (`eink-`) draws buttons with a 2 px border, 56 px high and 72 px of touch area, and keeps 24 px between two targets and margins of 40 and 32. The keyboards of the device stay as they were.

## Do's and Don'ts

- Do use one accent and change it in one line.
- Do keep Inter everywhere, and the logotype as a drawing.
- Do keep visible keyboard focus and respect `prefers-reduced-motion`.
- Don't load fonts, scripts or images from other domains.
- Don't make a pill button, or put the accent as both the background and the text of one button.
- Don't add a colour, a radius, a size or a spacing that is not in this file without changing the CSS and this file together.
- Don't put data about children or families in screenshots, examples or designs.

## Interaction pattern

The entry flows (login, first time) ask one question per screen, in Aule's own look. The change between questions is 250 ms: the screen leaves sliding and fading out and the next one enters the same way. With `prefers-reduced-motion: reduce` there is no transition. Enter advances, focus moves to the new question and the focus ring stays visible. It is drawn in Figma; the demo does not implement it yet.
