---
version: alpha
name: Aule
description: One design for every Aule product. White, ink and Notion's blue, set in Inter. Tokens without a prefix are the web (demo, parents' page, store); `eink-` is the 7.5 inch device screen and `esp32-` the small colour screen.
colors:
  paper: "#ffffff"          # the page. Notion: background-base
  surface-neutral: "#f6f5f4" # grey blocks and grey cards. Notion: gray-200
  surface-hover: "#0000000d" # interactive web only. Background under the pointer: black at 5%. Notion: alpha-black-100
  ink: "#000000e5"          # text: black at 90%. Notion: alpha-black-800 (text-normal)
  muted: "#0000008a"        # secondary text: black at 54%. Notion: alpha-black-500 (text-muted). 4.61:1 on white. On white only: on grey it is 4.52:1 laid over it, a margin of 0.02
  line: "#0000001a"         # dividers and the border of cards: black at 10%. Notion: alpha-black-200 (border-base). NOT for form controls: it is 1.26:1 on white
  field-border: "#78736f"   # the border of a form control (inputs, selects, text areas, check boxes and radios): 4.69:1 on white, over the 3:1 of WCAG 1.4.11. Notion: gray-500
  primary: "#0075de"        # the filled button, links and the focus ring. Notion: blue-600
  primary-hover: "#005bab"  # interactive web only. The filled button under the pointer. Notion: blue-700
  on-primary: "#ffffff"     # text on a primary background (4.57:1)
  secondary: "#e6f3fe"      # the quiet button and highlights. Notion: blue-200
  secondary-text: "#005bab" # text on secondary, and a link on a grey surface. Notion: blue-700
  secondary-hover: "#f2f9ff" # interactive web only. The quiet button under the pointer. Notion: blue-100
  link-hover: "#00396b"     # interactive web only. A link under the pointer. Notion: blue-800
  danger: "#b01601"         # errors and destructive actions. Notion: red-700
  danger-hover: "#6f0d00"   # interactive web only. A destructive control under the pointer. Notion: red-800
  success: "#0f6220"        # confirmations. Notion: green-700
  tile: "#14130f"           # PLAYGROUND ONLY: the video and tutor tiles
  tile-ink: "#f6f4ef"       # PLAYGROUND ONLY: text on the dark tiles
  board: "#ffffff"          # PLAYGROUND ONLY: what the tutor draws, always black on white like the device screen
  device-frame: "#1b1b1b"   # PLAYGROUND ONLY: the 14px frame of the device screen
  google-border: "#747775"  # THIRD PARTY (Google's sign-in button guide): its border. The only colour outside the palette; see button-google
  google-text: "#1f1f1f"    # THIRD PARTY (Google): its text
  eink-black: "#000000"     # the four levels of the device panel: 0, 85, 170 and 255
  eink-dark-grey: "#555555"
  eink-light-grey: "#aaaaaa"
  eink-white: "#ffffff"
  esp32-black: "#000000"    # small colour screen: black background,
  esp32-white: "#ffffff"    # white text,
  esp32-accent: "#0075de"   # the one accent, the same blue as the web's primary (Cesar's decision): buttons, "Listo", the microphone when it is on and the dot of "● Te escucho". White text on it is 4.57:1; on black it is 4.6:1
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
  google-button:
    fontFamily: "Roboto, Arial, sans-serif"
    fontSize: 14px          # THIRD PARTY (Google): the "Continuar con Google" button, Roboto Medium 14, from Google's guide. Cesar decided Inter on 23 Nov 2026 (see the Google rule under Components); this value changes when it is implemented
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
  google: 4px               # THIRD PARTY (Google): the radius of its button, from its guide
  esp32-md: 24px            # small colour screen: the radius of a button, 24 px, the same 2 mm as the web's 8px. Fixed
spacing:
  2xs: 4px                  # vertical padding of the small button
  xs: 8px                   # between buttons, between small items
  sm: 12px                  # vertical padding of the large button
  md: 16px                  # between a heading and its paragraph, between the fields of a form
  lg: 24px                  # side margin of the page and between cards
  xl: 32px                  # padding of a card
  2xl: 48px                 # between blocks inside a section
  3xl: 96px                 # between sections on desktop
  3xl-mobile: 64px          # between sections on a phone (from 640px up it is 3xl)
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
    textColor: "{colors.ink}"
    typography: "{typography.body}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 12px
  button-primary-sm:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-sm}"
    rounded: "{rounded.md}"
    padding: 4px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-text}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 12px
  button-secondary-hover:
    backgroundColor: "{colors.secondary-hover}"
    textColor: "{colors.secondary-text}"
  button-google:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.google-text}"
    typography: "{typography.google-button}"
    rounded: "{rounded.google}"
    height: 40px
  button-google-stroke:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.google-border}"
  button-link:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.primary}"
    typography: "{typography.button}"
  button-link-hover:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.link-hover}"
  link-on-neutral:
    backgroundColor: "{colors.surface-neutral}"
    textColor: "{colors.secondary-text}"
  button-danger:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.danger}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 12px
  button-danger-hover:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.danger-hover}"
  button-danger-link:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.danger}"
    typography: "{typography.button}"
  button-danger-link-hover:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.danger-hover}"
  button-destructive:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 12px
  button-destructive-hover:
    backgroundColor: "{colors.danger-hover}"
    textColor: "{colors.on-primary}"
  button-switch-off:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.muted}"
  button-switch-off-hover:
    backgroundColor: "{colors.surface-neutral}"
    textColor: "{colors.ink}"
  button-switch-on:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-text}"
  button-switch-stroke:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.field-border}"
  button-disabled:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.muted}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 12px
  button-disabled-stroke:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.muted}"
  button-talk-active:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "{spacing.xl}"
  card-neutral:
    backgroundColor: "{colors.surface-neutral}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "{spacing.xl}"
  card-note:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.muted}"
    typography: "{typography.small}"
    rounded: "{rounded.xl}"
    padding: "{spacing.md}"
  highlight:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-text}"
    rounded: "{rounded.md}"
  field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 12px
  field-placeholder:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.muted}"
  field-border-stroke:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.field-border}"
  divider:
    backgroundColor: "{colors.line}"
  row-hover:
    backgroundColor: "{colors.surface-hover}"
  note:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.muted}"
    typography: "{typography.small}"
  notice-error:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.danger}"
    typography: "{typography.small}"
    rounded: "{rounded.md}"
  notice-success:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.success}"
    typography: "{typography.small}"
    rounded: "{rounded.md}"
  message-tutor:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
  message-you:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.lg}"
  video-tile:
    backgroundColor: "{colors.tile}"
    textColor: "{colors.tile-ink}"
    rounded: "{rounded.lg}"
  board:
    backgroundColor: "{colors.board}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
  device-screen:
    backgroundColor: "{colors.device-frame}"
    textColor: "{colors.board}"
    rounded: 10px
  skip-link:
    backgroundColor: "{colors.ink}"
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
    textColor: "{colors.esp32-white}"
    typography: "{typography.esp32-button}"
    rounded: "{rounded.esp32-md}"
    height: "{spacing.esp32-target}"
  esp32-button-small:
    backgroundColor: "{colors.esp32-accent}"
    textColor: "{colors.esp32-white}"
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
  esp32-text-accent:
    backgroundColor: "{colors.esp32-black}"
    textColor: "{colors.esp32-accent}"
    typography: "{typography.esp32-body}"
  esp32-mic-on:
    backgroundColor: "{colors.esp32-accent}"
    textColor: "{colors.esp32-white}"
    rounded: "{rounded.esp32-md}"
    height: "{spacing.esp32-target}"
  esp32-listening-dot-stroke:
    backgroundColor: "{colors.esp32-black}"
    textColor: "{colors.esp32-accent}"
  esp32-title:
    backgroundColor: "{colors.esp32-black}"
    textColor: "{colors.esp32-white}"
    typography: "{typography.esp32-title}"
---

## Overview

One design for every Aule product: the demo and the parents' page (`aule-sw`), the store (`aule-store`), the device screen and the small colour screen. It is white, ink and one blue, and it reads calmly, like a tool and not like a toy. Every heading, the tutor's words, the interface and the "Aule" logotype are set in Inter. The logotype is the word "Aule" as text in Inter Semi Bold (600), the same as the brand component of the Figma, at the size that component gives each screen.

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

`eink` uses only the four levels of grey. `esp32` does not use the `web` palette: it is a black background and white text with **one** accent, `#0075de`, the same blue as the web's `primary`: the fill of the buttons (with white text), "Listo", the microphone when it is on and the dot of "● Te escucho". Its contrast is the web's: 4.5:1 in text and 3:1 in graphics. Its type scale is its own, because it is looked at from close and a conversion from `eink` does not fit in 480 px: nothing below 32 px (2.6 mm), body 40, title 48, buttons 32 to 40 and press targets of 150 px or more (12 mm). Between two targets there are at least 38 px (3 mm, `esp32-target-gap`). A button has a 4 px border (`esp32-stroke`) and a radius of 24 px, the same 2 mm as the web's. A disabled button has its text in white at 70 % (`esp32-white-70`) and a dashed border in `esp32-disabled` (#707070), a grey that is used for nothing else: it is 4.2:1 on black, which is a graphic and has to reach 3:1 (WCAG 1.4.11), not the 4.5:1 of text. The rest of its type scale is a proposal until it is tried on the real screen.

| | `web` | `eink` | `esp32` |
|---|---|---|---|
| Letter | Inter, the scale of Typography | Inter: titles Semi Bold 34/40, text 22/30, options Semi Bold 24, 18 at the least | Inter with its own scale |
| Line height of text | 1.5 | 1.35 to 1.4 | 1.25 |
| Negative tracking on big headings | yes | no | no |
| Button | radius 8, weight 500, padding 12 x 20 | radius 8, 2 px border, 56 px high, 72 px of touch area | `#0075de` background with white text, 4 px border, radius 24, target of 150 px or more, 38 px between targets |
| Spacing | the whole scale, 4 to 96 | 4 to 64: margins of 40 and 32, 24 between targets | its own scale on a base of 4 |
| Colour and shadows | white, ink, one blue, no shadows | four greys | black background, white text and one accent, `#0075de` |

## Colors

Aule has no colour of its own: the palette is Notion's, taken from the `--tatami-color-*` variables of its public `skilljar.css?v=32` (read on 23 Nov 2026), and each colour above says which variable it comes from. Not the logo, the texts or the illustrations: only the palette and the scale.

White (`paper`) is the page; `surface-neutral` is for grey blocks and cards, and `surface-hover` is what shows under the pointer. Text is `ink` (black at 90 %) and `muted` (black at 54 %); dividers and the border of a card are `line` (black at 10 %), and the border of a form control is `field-border` (`#78736f`), because `line` is 1.26:1 on white and a control's edge has to reach 3:1. The one colour is the blue: `primary` for the filled button, links and the focus ring, `primary-hover` under the pointer, `secondary` with `secondary-text` for the quiet button and highlights, `link-hover` for a link under the pointer. `danger` is for errors and what cannot be undone and `success` for confirmations. `tile`, `tile-ink`, `board` and `device-frame` are **playground only**: the video tiles and the device screen of the demo are not drawn on any other page. Every `*-hover` colour, and the disabled, switch and talk-active components, are **interactive web only**: they exist where a pointer or a state exists, and not on the device screens. Both groups carry that in the Figma files (`scope`). The `eink-` colours are the four levels of the panel; the `esp32-` colours are the black screen, its white, its one blue (`esp32-accent`, for button fills and for text) and the grey of a disabled button, and the screen does not use the web palette.

**Transparency.** The CLI accepts a colour with an alpha channel as eight hex digits (it ignores the alpha when it measures contrast, so `row-hover` has only a background: its own test lays the colours over white) (`#000000e5`), so `ink`, `muted`, `line`, `surface-hover` and `esp32-white-70` are kept as Notion has them, not composed over white. The contrast test lays a transparent colour over its background (and a transparent background over `paper`) before it measures. In the Figma files they carry their hex and an `alpha`.

**Two rules of contrast** that come from the numbers: a link in `primary` on `surface-neutral` is 4.19:1 and does not reach 4.5, so a link on grey is `secondary-text` (`link-on-neutral`); and `muted` on grey is 4.52:1 laid over it, which passes but by 0.02: any change of the grey, of the alpha or of the text size leaves no room, so it goes on white only. The rule stays for that margin, and not because it fails. A test checks both.

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

**Letter spacing is written in em** (`letterSpacing: -0.023em`), so that it follows the size, and the pixels that Figma asks for come from it: `figma-*.json` writes `letter-spacing` as the em times the font size, that is −0.736 px at 32 px (`headline-sm`, −0.023 em) and −0.251 px at 22 px (`card-title`, −0.0114 em). A test checks every one.

## Layout

A page is at most `container` wide, with `lg` on each side. A paragraph is at most `text-column` wide. Sections are `3xl` apart on desktop and 64 px on a phone; blocks inside a section are `2xl` apart; a heading and its paragraph are `md` apart. The scale is on a base of 4: `2xs` 4, `xs` 8, `sm` 12, `md` 16, `lg` 24, `xl` 32, `2xl` 48, `3xl` 96. Other isolated values (2, 6, 10 and 14 px, and the 20 px at the sides of a button) stay in the CSS and are not tokens.

## Elevation & Depth

None. No soft shadows: separation comes from `line` borders, from `surface-neutral` and from air. The form card and the board keep a flat shadow in `surface-neutral` as a drawn edge, not a blur.

## Shapes

Radius 8 for buttons, fields and notices; 12 for tiles and messages; 16 for cards. A button is never a pill. `full` is for the orb and round marks.

## Components

- **Buttons.** A rectangle with radius 8, a 1 px transparent border and weight 500. Large: 16/24 with 12 x 20 padding. Small: 14/20 with 4 x 14 padding and 34 px of height. Primary is `primary` with `on-primary` text and `primary-hover` under the pointer; quiet is `secondary` with `secondary-text` and no border; the link is `primary` text with an arrow (`Find answers →`) and no background. Buttons are 8 px apart.
- **The Google sign-in button ("Continuar con Google") keeps Google's colours and shape, and its text is in Inter.** Cesar decided on 23 Nov 2026: "No, usa nuestra tipografía". Google's branding guide asks for Roboto on that button, so this is a known brand risk, and Gonzalo makes the final call when he implements it. Until then the `google-button` token below still says Roboto Medium 14: change it to Inter when it is implemented. The rest is as Google's guide gives it: 40 px high, radius 4 (`rounded.google`), a `#747775` border (`google-border`, `button-google-stroke`, a graphic) and `#1f1f1f` text (`google-text`) on white. Nothing else may use those tokens: a test fails if any component other than `button-google*`, or any CSS of a product, uses them or Roboto. In the playground Google draws the button itself; Aule does not load Roboto. The 40 px is smaller than Aule's 48 px targets, so the touch area around it is 48 px.
- **Variants reach the CSS only through generated variables.** For every web component, `pnpm design-tokens` writes `--aule-c-<component>-bg`, `-text`, `-type`, `-radius`, `-padding` and `-height` (and `-border`, which for a button is its own background), so `components.button-primary` is the only place the filled button's colours are written, and the CSS of each product only reads them. A test changes a variant here and demands that the generated CSS changes, and a browser test demands that the buttons of the real pages paint what this file says.
- **A destructive button** is `danger` with white text (`button-destructive`) and `danger-hover` under the pointer (`button-destructive-hover`, Notion's red-800, `#6f0d00`); the outlined one (`button-danger`) and the quiet red link (`button-danger-link`) go to `danger-hover` text too. None is a blend with black, and a browser test passes the pointer over every button.
- **A disabled or sending button is `button-disabled`**: white, `muted` text (4.61:1) and a dashed border in the colour of `button-disabled-stroke` (a graphic, 3:1). Never opacity: at 60 % a filled button's text fell to 2.7:1. An error alert is `notice-error` (`danger` text on `paper`), not a colour of the framework.
- **Every pair of text and background above must reach 4.5:1, in the `esp32-` components too.** `pnpm --filter @aule/design test` walks them one by one. A component whose name ends in `-stroke` is a graphic, not text (a border, an icon): its `textColor` is the line, its `backgroundColor` is what it is drawn on, and it has to reach 3:1 (WCAG 1.4.11). A colour with transparency (`#ffffffb3`) is laid over its background before it is measured. The linter of the CLI measures every pair as text and so warns once, about `esp32-button-disabled-stroke`; the test allows that one warning and no other.
- **Form controls** (inputs, selects, text areas, check boxes and radios, and the cards that stand for a choice) have a 1.5 px `field-border` border (`field-border-stroke`, a graphic: 3:1; it is 4.69:1) and, the fields, radius 8; `line` is never used for them. A browser test measures the computed border of every control, **switches included** (`button[aria-pressed]`, in both states, `button-switch-stroke`), and demands 3:1; the placeholder of an empty field is `muted` (`field-placeholder`, 4.57:1) and the same test measures it; the focus ring is 3 px of ink with 2 px of offset.
- **The device screen** (`eink-`) draws buttons with a 2 px border, 56 px high and 72 px of touch area, and keeps 24 px between two targets and margins of 40 and 32. The keyboards of the device stay as they were.

## Do's and Don'ts

- Do use the one blue, and a link on grey in `secondary-text`.
- Do keep Inter everywhere, the logotype too (Inter Semi Bold).
- Do keep visible keyboard focus and respect `prefers-reduced-motion`.
- Don't load fonts, scripts or images from other domains.
- Don't make a pill button, or put the same colour as both the background and the text of one button.
- Don't add a colour, a radius, a size or a spacing that is not in this file without changing the CSS and this file together.
- Don't put data about children or families in screenshots, examples or designs.

## Interaction pattern

The entry flows (login, first time) ask one question per screen, in Aule's own look. The change between questions is 250 ms: the screen leaves sliding and fading out and the next one enters the same way. With `prefers-reduced-motion: reduce` there is no transition. Enter advances, focus moves to the new question and the focus ring stays visible. It is drawn in Figma; the demo does not implement it yet.
