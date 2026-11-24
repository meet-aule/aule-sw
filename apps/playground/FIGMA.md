# The playground and the Figma «Login-Aule» v8

The page follows the Figma file **«Login-Aule»** (key `yOAIYJNl5nZ7NgWtESN0Fo`): its flows, its screens, its components and its calm look, adapted to the web. It is not a pixel copy. This file maps the Figma to the code.

## 1. The file

| | |
|---|---|
| File | «Login-Aule», `yOAIYJNl5nZ7NgWtESN0Fo`, read-only from the code's side |
| Pages followed | `160:1345` «Vigente · Login padre · v8» (the parent's screens, Móvil 390×844 and Escritorio 1280×800) and `190:717` «Vigente · Login alumno · v8» (the student's screens, «· Aparato» 800×480) |
| Not followed | The Pendiente pages (Cuenta del padre, Aparato del alumno, Login alumno Mosaico) and the Archivo pages |
| Read | 23 November 2026 |

Code Connect is not available on the team's Pro plan, so this file is the map between the Figma and the code, and three conventions in the code point back to the file (§2).

## 2. How the code cites the Figma

- **HTML.** Every screen of `public/index.html` is one `<section class="screen" data-screen="…" data-surface="paper|ink">`, and the comment right before it names its frame and node ids, for example `<!-- Figma: P02 Tu correo · Móvil 160:1624 / Escritorio 160:1755 -->`. A screen the Figma does not draw says `web-only` and names the components it is built from. A state inside a screen has its comment at the element that changes (`P04 · Marcada` at the box, `P13 · De vuelta` at the greeting, `A05 · Silenciado` and `A15 · Silenciado` at the microphone).
- **CSS.** `public/style.css` names each Figma variable next to its token and each component (with its variants' ids) above its rules, for example `/* Figma: Opción/Grande 160:1374 (Normal 160:1375, Seleccionada 160:1379, Foco 160:1384, Error 160:1388) */`.
- **JS.** `public/steps.js` holds the table of screens (`SCREENS`): each one's Figma code, name, node ids, surface, progress step and way back. The router (`public/screens.js`) draws the progress header from it.
- **Tests.** `test/figma.test.mjs` checks that every section has its comment, that the sections and `SCREENS` are the same set with the same node ids and surfaces, that this file names every Vigente screen, component, token and icon, and that the stylesheet names each component and variable.

## 3. Screens

Surface: **paper** is the parent's look (page 160:1345), **ink** the device's pure black on white (page 190:717). Status: **build** (as the Figma draws it), **adapt** (built, with a difference in §7), **restyle** (a screen the page already had, in the new look), **web-only** (not in the Figma, built from its components), **out** (not built, §8).

### 3.1 The parent (page 160:1345)

| Figma | Móvil / Escritorio | `data-screen` | Surface | Status | Logic in |
|---|---|---|---|---|---|
| C00 ¿Quién eres? | 160:1649 / 160:1727 | `c00` | paper | build | `signin.js` |
| — (mirrors the device's C00 · Padre 190:1035) | — | `c00-student` | ink | web-only | `signin.js` |
| C01 ¿Ya tienes cuenta? | 160:1661 / 160:1741 | `c01` | paper | build | `signin.js` |
| P01 ¿Cómo quieres entrar? | 160:1636 / 160:1455 | `p01` | paper | build | `signin.js` |
| P02 Tu correo | 160:1624 / 160:1755 | `p02` | paper | build | `signin.js` |
| P03 Código | 160:1604 / 160:1768 | `p03` | paper | build | `signin.js` |
| — (after P03: the parent's name) | — | `p03-name` | paper | web-only | `signin.js` |
| P04 Tu autorización (+ P04 · Marcada) | 160:1592 / 160:1442; Marcada 160:1994 | `p04` | paper | build | `onboarding.js` |
| P05 Conozcamos a tu hijo | 160:1581 / 160:1789 | `p05` | paper | adapt | `onboarding.js` |
| P06 Entrevista · expectativas | 160:1568 / 160:1801 | `p06` | paper | adapt | `onboarding.js` |
| — (interview question 2: the grade) | — | `p06-grade` | paper | web-only | `onboarding.js` |
| P07 Entrevista · gustos | 160:1547 / 160:1815 | `p07` | paper | adapt | `onboarding.js` |
| P08 Conecta Aule a internet | 160:1530 / 160:1837 | — | — | out | — |
| P09 Enlaza Aule | 160:1509 / 160:1855 | — | — | out | — |
| P10 Nombre de usuario | 160:1493 / 160:1877 | `p10-name` takes its place | paper | web-only | `onboarding.js` |
| P11 Confírmalo en Aule (+ · No es su nombre) | 160:1479 / 160:1894; 160:1973 / 160:1982 | — | — | out | — |
| P12 Listo | 160:1469 / 160:1909 | `p12` | paper | adapt | `onboarding.js`, `home.js` |
| P13 Entra a tu cuenta (+ · De vuelta) | 160:1674 / 160:1920; 160:1711 / 160:1934 | `p13` | paper | build | `signin.js` |
| P14 Revisa tu correo | 160:1688 / 160:1948 | `p14` | paper | adapt | `signin.js` |
| P15 Escríbenos | 160:1701 / 160:1962 | `p15` | paper | adapt | `signin.js` |
| — (the family's students; Pendiente · Cuenta del padre is not Vigente) | — | `home` | paper | restyle | `home.js`, `signin.js` (signing out, erasing) |
| — (a student's settings; no Figma screen) | — | `editor` | paper | restyle | `students.js`, `home.js` |

### 3.2 The student (page 190:717)

| Figma | Aparato | `data-screen` | Surface | Status | Logic in |
|---|---|---|---|---|---|
| A04 ¿Qué hacemos hoy? | 190:891 | `a04` | ink | build | `home.js` |
| — (after A04: subject, topic, day) | — | `a04-details` | ink | web-only | `home.js` |
| A05 Antes de empezar (+ · Silenciado) | 190:899; 190:1005 | `a05` | ink | restyle | `app.js` |
| A15 La sesión empieza (+ · Silenciado) | 190:1069; 194:509 | `session` | ink | adapt | `app.js` |
| C00 ¿Quién eres? · Aparato, C00 · Padre, C01 · Aparato | 190:906, 190:1035, 190:912 | — | — | out | — |
| A01 Enlazar, A02 ¿Eres tú?, A03 No soy yo | 190:869, 190:884, 190:984 | — | — | out | — |
| A06 Correo de tu papá o mamá; A07 Reglas (+ Primera marcada, Segunda marcada, Ambas marcadas, Términos, Reglas de Aule); A08 Ya casi; A09 Elige tu nombre de usuario; A10 Crea tu contraseña; A11 Entra con tu usuario; A12 No encontramos ese usuario; A13 Le avisamos; A14 Te ayudamos | 190:918; 190:924, 190:1055, 190:1061, 190:1029, 195:493, 195:503; 190:930; 190:938; 190:946; 190:952; 190:961; 190:990; 190:966 | — | — | out | — |

### 3.3 The flows

```
c00 ─Soy padre de familia→ c01 ─No, es mi primera vez→ p01 ─Con mi correo→ p02 → p03 ─(a new address)→ p03-name
p01 ─Continuar con Google | Otras formas de entrar (GitHub, Facebook, Apple)→ signed in
signed in → p04 (no students) or home
p04 ─Autorizo→ p05 ─Empezar entrevista→ p06 → p06-grade → p07 → p10-name ─Guardar→ p12
p05 ─En otro momento→ p10-name
c01 ─Sí, ya tengo cuenta→ p13 → (the same ways) → home
p03 ─No me llega el correo→ p14 ─¿Sigue sin llegar? Escríbenos→ p15 (mailto:admin@meetaule.com)
c00 ─Soy alumno→ c00-student ─Volver→ c00
home ─a student→ a04 ─a tile→ a04-details ─Seguir→ a05 ─Empezar la sesión→ session ─Terminar→ home
a04 ─No lo sé→ a05 (no objective)        home ─Configurar→ editor
```

Each step forward is an entry in the browser's history: Back and «← Atrás» go to the step before. Signed in, the steps before signing in are not stepped back into; during a session Back does nothing.

## 4. Components

| Figma component (id; variants) | Class / element | States in code | Used on |
|---|---|---|---|
| Encabezado/Base 160:1348 (Atrás=Sí 160:1349, Atrás=No 160:1352) | `.screen-head` > `.head-row` with `.wordmark` and `button.link.back[data-back]` | no `.back` for Atrás=No | every paper screen |
| Barra de progreso/Base 160:1415 (Sin avance 160:1416; 1–12 de 12 160:1417…160:1439) | `ol.progress` with three `li.segment` (track, fill, name); `ol.progress.plain` | drawn by `screens.js` from `steps.js` | every paper screen |
| Pregunta/Base 161:2101 | `.question` > `.question-step`, `h2.question-title[tabindex=-1]`, `.question-help` | step and help optional | every paper screen |
| Campo/Línea 160:1355 (Vacío 160:1356, Lleno 160:1362, Error 160:1368) | `.field` > `label`, `input`/`textarea`/`select`, `.field-error` | `aria-invalid="true"` draws the error | p02, p03-name, p06, p07, p10-name, editor, erase |
| Opción/Grande 160:1374 (Normal 160:1375, Seleccionada 160:1379, Foco 160:1384, Error 160:1388) | one choice: `button.option`; several: `label.pick` > checkbox + `span.option`; the editor's `label.chip` and `label.tone` | `aria-pressed`/`:checked` → `--picked` fill and «✓»; `:focus-visible` → Foco | c00, c01, p01, p13, p06-grade, p07, editor |
| Botón/Principal 160:1392 (Normal 160:1393, Deshabilitado 160:1395) | `.primary` (a `button`, or the `a` of p15) | `:disabled` → `--line` fill, `--muted` label | the foot of the paper screens |
| Casilla/Base 160:1397 (Sin marcar 160:1398, Marcada 160:1401) | `label.check` > the real checkbox, out of sight over the whole row, + `.box`; `.check.boxed` with its frame | `:checked` → ink box with «✓»; P04's box starts unticked, its panel starts with «Recordar…» ticked and «Guardar por escrito…» not (D5) | p04 and its panel, editor |
| Dígito/Base 160:1405 (Vacío 160:1406, Foco 160:1408, Lleno 160:1410) | `.digits`: one real `input#email-code` over six `aria-hidden` boxes | the next box has `.focus` (2.5 px copper) | p03 |
| Enlace/Base 161:2096 | `.link` (`button` or `a`); `.link-small` (P14's small link) | — | «← Atrás», «Reenviar», «Qué guardamos», «En otro momento», «Saltar pregunta», «Terminar», the home's links |
| Acción/Pequeña 161:2104 | `button.small` | — | «Configurar», «Olvidar», «Agregar», «Entendido» |
| Fila/Alumno 161:2110 | `li.student-row` > `button.student-go` (name, description) + `button.small` | `aria-disabled` when the plan has no session left | home |
| Botón/Google 168:991 | `#google-p01`, `#google-p13`: Google draws its own button there | — | p01, p13 |
| (web addition) Botón/Principal in the error colour | `.primary.danger` | — | «Borrar mi cuenta» |
| (web addition) Enlace/Base in the error colour | `.link.danger` | — | «Quitar a este alumno» |
| Vista previa/Base 161:2113 | not used: the camera's preview is on an ink screen (`.preview`) | | |
| Cuadro/Opción 190:806 (Cuadrícula Normal 190:822, Seleccionada 190:825; Grande 190:807 / 190:809) | `button.choice` > `.icon` + label | `aria-pressed="true"` → black, 4 px border, white icon and words, a check at the right | a04 |
| Botón/Negro 190:834 (Normal 190:835, Deshabilitado 190:838) | `.ink-button` | `:disabled` → white, dashed black border (§7, D14) | c00-student, a04-details, a05 |
| Botón/Micrófono 193:709 (Encendido 193:705, Apagado 193:708) | `button.round-toggle` (112 px; `.round-88`, `.round-64`) | `aria-pressed` swaps the fill and the icon; `aria-describedby` points at the sentence | a05 microphone and camera, the session's microphone |
| Botón/Compacto 191:1396 | `.compact` | a toggle off (`aria-pressed="false"`) keeps its solid border, as Botón/Micrófono · Apagado: its label says «apagada»/«apagado» and the camera's Ícono/videocam turns into videocam_off; `:disabled` → dashed border (D14) | the session's camera, «Modo tinta», «Terminar», «Enviar», «Responder» |
| Campo/Línea · Aparato 191:1333 | `.ink-field` | the example in italic | a04-details |
| «Enlace · …» pattern (195:513, 190:959) | `.ink-link`: underlined, 60 px tall | — | «Volver», «Revisar una evaluación que ya di» |
| Íconos · Aparato 190:995 | `.icon[data-icon="…"]`: a CSS mask of the icon's path, in `currentColor` | follows the control's colour | a04, a05, the session |

Focus: on paper, every control's `:focus-visible` is Opción/Grande · Foco's ring, 3 px of `#9a5b2e` drawn solid (D19) as an outline 2 px out, so forced colours keep it; a hidden checkbox draws it on its face (`.box`, `.option`, the chip's `span`), and a line field keeps its rule with a 3 px copper line under it. On ink, a 3 px black outline 3 px out. Each screen change moves the focus to its title.

## 5. Tokens and type

| CSS | Value | Figma |
|---|---|---|
| `--bg` | `#f5f2ea` | color/fondo `VariableID:3:4` (collection «Aule — color» 3:3) |
| `--surface` | `#fbfaf6` | color/tarjeta `VariableID:3:5` |
| `--ink` | `#141414` | color/texto `VariableID:3:6` |
| `--muted` | `#6b6b6b` | color/secundario `VariableID:3:7` |
| `--line` | `#c9c3b4` | color/linea `VariableID:3:8` |
| `--copper` | `#9a5b2e` | color/acento `VariableID:3:9` |
| `--picked` | `#ebe4d3` | raw, Opción/Grande · Seleccionada |
| `--danger` | `#8f1d14` | raw, Campo/Línea · Error |
| `--focus` | `#9a5b2e`, solid | Opción/Grande · Foco's ring, which the Figma draws at 40 % (D19) |
| `--device-ink` | `#000000` | nivel/negro `VariableID:162:427` (collection «Aparato — e-ink» 90:691) |
| `--device-paper` | `#ffffff` | nivel/blanco `VariableID:162:430` |
| `--radius` | 10 px | the parent's options, buttons, boxes and digits |
| `--device-radius` | 12 px | radio/tecla `VariableID:90:699` |
| `--device-card-radius` | 20 px | radio/cuadro `VariableID:90:698` |
| `--serif` | Source Serif 4 (`fonts/serif.woff2`, `@fontsource-variable/source-serif-4` 5.3.1) | titles and the wordmark |
| `--sans` | Inter (`fonts/sans.woff2`, `@fontsource-variable/inter` 5.3.0, latin subset; `fonts/sans-italic.woff2` only for the device fields' examples) | everything else |

| Role | Paper | Ink (from 800 px; four fifths of it on a phone) |
|---|---|---|
| Wordmark «Aule» | Source Serif 4 600 18 | — |
| Title | Source Serif 4 500 28/34 | Inter 600 34/46 |
| Step («Empezar», «1 de 3», «Listo») | Inter 500 14, copper | — |
| Help under the title | Inter 400 15/22, muted | Inter 400 22/34 |
| Option | Inter 400 16/20 | Inter 600 24/34 |
| Primary button | Inter 600 16 on ink | Inter 600 24/30, white on black |
| Link | Inter 500 15, underlined | Inter 600 22/30, underlined |
| Field label / text | Inter 500 14 muted / Inter 400 22 | Inter 600 22 / Inter 400 30 (example in italic) |
| Digit | Inter 600 24 | — |
| Progress part | Inter 500 12 | — |
| Error | Inter 400 14, `#8f1d14` | Inter 600 22, black |

Layout: on a phone (under 768 px) a paper screen is the viewport's height with 24 px of padding, the header, a body that grows and the foot at the bottom edge; from 768 px it is a 560 px column centred both ways, the foot after the content. Ink screens are white; from 800×480 the content sits in an 800 px area with 40 px at the sides and 32 above and below, the primary button bottom right and the links bottom left; under 800 px they are one column with the button full width.

Motion: paper screens come up 16 px as they fade in (240 ms, ease-out), as the Figma's phone prototype moves in; going back they come down. Ink screens change at once. With reduced motion asked for, nothing moves.

## 6. Icons

All are Material Icons (Outlined) by Google, Apache License 2.0, from github.com/google/material-design-icons. The page uses their path data as CSS masks (`.icon[data-icon]` in `style.css`), so they take the colour of the control.

| Figma | Id | Source | Used on |
|---|---|---|---|
| Ícono/check | 191:1398 | `src/navigation/check/materialiconsoutlined/24px.svg` | Cuadro/Opción · Seleccionada (`--check`) |
| Ícono/mic | 191:1401 | `src/av/mic/materialiconsoutlined/24px.svg` | a05, the session |
| Ícono/mic_off | 191:1404 | `src/av/mic_off/materialiconsoutlined/24px.svg` | a05, the session (off) |
| Ícono/videocam | 191:1407 | `src/av/videocam/materialiconsoutlined/24px.svg` | a05's camera, the session's «Cámara» |
| Ícono/videocam_off | 191:1410 | `src/av/videocam_off/materialiconsoutlined/24px.svg` | a05's camera, the session's «Cámara apagada» |
| Ícono/task_alt | 191:1413 | `src/action/task_alt/materialiconsoutlined/24px.svg` | a04 «Terminar tareas de la escuela» |
| Ícono/assignment | 191:1415 | `src/action/assignment/materialiconsoutlined/24px.svg` | a04 «Repasar para una evaluación» |
| Ícono/school | 191:1418 | `src/social/school/materialiconsoutlined/24px.svg` | a04 «Quiero aprender algo nuevo» |
| Ícono/help_outline | 191:1421 | `src/action/help_outline/materialiconsoutlined/24px.svg` | a04 «No lo sé» |

## 7. Differences from the Figma

Each is what the code does today; the owner can change any of them.

| # | Difference | Why |
|---|---|---|
| D1 | One page; each screen is a section shown by `screens.js`. Steps forward are history entries; during a session Back does nothing. | The flows are step by step; a session started by mistake costs a family its day. |
| D2 | A web-only `p03-name` asks the parent's name when the platform answers `name_needed`, then verifies the same code again. | The platform needs the name for a new family; the Figma has no name step. |
| D3 | P01 and P13 show Google and the email code as the Figma does; GitHub, Facebook and Apple stay under «Otras formas de entrar» (open when they are the only ways). | The Figma shows two ways; the others work today. |
| D4 | P04's text is the Figma's, word for word. It is recorded as the `voice` consent with policy version `playground-2026-11-v8`. | The platform has no camera purpose yet (§8); each record says which text was seen. |
| D5 | Under «Qué guardamos», a panel open from the start holds the two choices the editor keeps, with the editor's defaults: «Recordar entre sesiones…» ticked, «Guardar por escrito…» not; then «El audio y el video nunca se guardan.» and the privacy policy; the link folds it. Each choice is recorded as its own consent (`memory`, `transcripts`) when the child is made, granted only if ticked. | The Figma does not draw where it goes. These are today's defaults (the editor's, and the server's when nothing is sent), so a child made here keeps what one made in the editor kept. The panel is open, so the parent sees both before «Autorizo» and can change either; only P04's own box, the parent's consent, starts unticked (Nota · P04). If legal wants remembering to be opt-in, it is `DEFAULTS.remembers` in `onboarding.js` and the `checked` on `#keep-memory` (and the editor's `#student-remembers`). |
| D6 | The interview has three questions: P06 (the note for the tutor), a web-only grade, P07 (interests). P05 says «3 preguntas, un par de minutos». | Five of the seven questions are not designed. |
| D7 | The child's name is a required web-only step in the place of P10, in the third part; the child is made there. | The platform needs a nickname to make a child. |
| D8 | The progress parts are «Tu cuenta» (4 steps) · «Conocer a tu hijo (opcional)» (4) · «Su perfil» (2), widths 4 : 4 : 2. P02 and P03 show the plain line for a family coming back. | «Enlazar Aule» is the device's; a returning parent is not onboarding. |
| D9 | P12 says «Listo. Aule ya conoce a {nombre}», offers «Empezar su primera sesión» and «Terminar», and «Pronto también podrás enlazar aquí el aparato Aule.» With no session left in the plan, only «Terminar» shows, and the plan's line (the home's) takes the place of «Ya puede empezar su primera sesión…». | On the web the next thing is a session in this browser. |
| D10 | P14 speaks of a code (not a link), without «Crear mi cuenta»; its small link is «¿Sigue sin llegar? Escríbenos». P15 writes to admin@meetaule.com with the address already in the message, instead of WhatsApp. | The platform sends codes and never says when a cap is hit; WhatsApp needs a number, a legal note and a cap that can be shown. |
| D11 | A04 has the Figma's four tiles; «No lo sé» sends no objective; a link «Revisar una evaluación que ya di» keeps the fifth kind; a web-only details step asks subject, topic and (for homework and evaluations) the day. | The platform has five kinds, and subject, topic and day are working features. |
| D12 | A05 is César's design plus a camera row in the same pattern (88 px, videocam icons, its sentence, a preview), the level bar and «Volver». | The web needs the camera; the device's A05 leaves it for later. |
| D13 | The session starts in A15's state: «La sesión empezó.» and the round microphone with «Tu micrófono está encendido / apagado.»; the rest of the session keeps its layout, in black on white, and Aule's face stays. | A15 is where the Figma hands over to the session. |
| D14 | A disabled device button (Botón/Negro, and Botón/Compacto in the session) is white with a dashed black border, not the Figma's grey `#aaaaaa` border. A toggle that is off is not disabled and keeps its solid border. | «Pure black and white» on the device. |
| D15 | The Andean layer (wall, motifs, parchment, frames, hammered metal, dancing cuyes) is gone; the favicon and touch icons stay. | The owner's instruction for these flows. |
| D16 | The tabs «Crear cuenta / Iniciar sesión», the trial line and the list of benefits leave the sign-in; C00 and C01 replace the tabs. | None of it is in the Figma. |
| D17 | The editor («Configurar») is for existing students only; a new student is always made through P04 → name → P12. | One way to make a child, the one the Figma draws. |
| D18 | The home (not in the Vigente pages) is built from Pregunta/Base, Fila/Alumno, Acción/Pequeña and Enlace/Base. | v8's components wait for it. |
| D19 | The focus ring is `#9a5b2e` at full strength, drawn as an outline, not the Figma's drop shadow at 40 %. | At 40 % it is 1.73:1 on the paper; a focus indicator needs 3:1 (4.80:1 solid). Forced colours drop shadows but keep outlines. |
| D20 | A05 ignores taps for 1.2 s after it shows (the other student screens 300 ms), and under 800×480 the web-only `a04-details` puts «Seguir» right after its fields rather than on the bottom edge. | Nota · A04: «Empezar la sesión» must not be where a late tap lands, and the device ignores taps until its refresh ends (1.5 s). `a04-details`' «Seguir» would sit where «Empezar la sesión» shows next. |
| D21 | Every paper control is at least 44 px tall: links have 13 px above and below their line («← Atrás» keeps the header's 25 px row), and Acción/Pequeña, the chips and GitHub, Facebook and Apple are 44 px (the Figma's 40); the line fields are 44 px with their rule. | A target a finger can hit; the look stays the same. |
| — | C00 starts with no option chosen (the frame shows the first one chosen: a prototype state). Google's button stops at its 400 px on desktop. | — |

## 8. Not built, and what would need the platform

Not built: every device-only screen (A01–A03, A06–A14 with A07's states, the device's C00, C00 · Padre and C01, and P08–P11 with «P11 · No es su nombre»; two «Pronto» lines on `p12` and `c00-student` mark where they will go); the child's username and password and the parent's «Accesos»; WhatsApp help on P15; the Pendiente pages; the tutor's drawings and «Modo tinta»'s greys; replacing Aule's face; the landing page and the shop.

| Platform need | Why | Size |
|---|---|---|
| A `camera` consent purpose (`PURPOSES` in `families.rs`, a migration for `consent_records_purpose_check`, the agent's photo tool) | P04 names the notebook's pictures; today they ride on `voice` with the new policy version | small, with a migration |
| Making an email account without the parent's name (`signin.rs` `enter()`) | Removes `p03-name` | small, product decision |
| A cap of 3 recovery emails a day by address and IP, with its own error | Lets P15 say «Llegaste al límite de hoy»; WhatsApp also needs a number and a legal note | medium |
| A field for «¿Qué esperas de Aule en el día a día?» | Today it goes into the note for the tutor | medium |
| The device side for P08–P11 and A01–A04 (claim codes with spaces or hyphens, the QR address, the child's username and the device's confirmation, the objective in `/ota/session`) | The device-only screens | large |

## 9. Comparing with the Figma

1. Start a stand-in platform that answers the routes the page calls (sign-in by code, `/v1/me`, `/v1/me/plan`, children, consents, sessions) and the playground against it (`AULE_PLATFORM_URL`, a `PLAYGROUND_BASE_PATH`, `PLAYGROUND_PUBLIC_URL=http://127.0.0.1:<port>`).
2. Open the page in a headless Chromium with a fake camera and microphone, serving a small fake in place of `livekit-client.js` so the lobby and the session can be shown without LiveKit (and a fake of Google's script, or the real one).
3. Take each screen at 390×844 (against the Figma's Móvil frames), 1280×800 (Escritorio) and, for the student's screens, 800×480 (Aparato), and put each next to its frame's screenshot (`get_screenshot` of the node ids in §3).
4. Judge the structure, the words, the components, the states, the spacing and the colours, not the pixels.
