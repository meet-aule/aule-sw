# Diseño único: entrega

constructor-2 · 23 nov 2026 · ramas `claude/diseno-unico` de `aule-sw` y `aule-store` · para el arquitecto; revisa `aule-qa`.

## Lo hecho

| Punto | Estado |
|---|---|
| 1. `DESIGN.md` original en la raíz de `aule-sw` | Hecho. CLI `@google/design.md` 0.4.0 (publicada el 27 jul 2026: 119 días). `lint`: 0 errores y 0 avisos. Inter con la escala de §5, botones (radio 8, peso 500, grande y chico, principal, quieto y enlace), espaciado con los nombres de §5 (`text-column` y `container` para los dos últimos), un papel, una tinta y **un** acento (`accent` #9a5b2e sobre `paper` #f5f2ea) y los modos `web`, `eink-` y `esp32-`. `apps/playground/DESIGN.md` queda como apunte al de la raíz. |
| 2. Generación | `design/tokens.mjs` (`pnpm design-tokens`): `apps/playground/public/tokens.css`, `design/figma-web.json`, `figma-eink.json`, `figma-esp32.json`. `--check` y el test `design/test/design.test.mjs` fallan si un archivo generado no coincide (probado a mano: una línea añadida a `tokens.css` lo rompe). En la tienda: `app/tokens.css`, `npm run design-tokens` y el mismo test en vitest. |
| 3. Playground | `style.css`: Inter autoalojada (`public/fonts/InterVariable.woff2`, byte a byte de `web/InterVariable.woff2` de Inter-4.1.zip, con `Inter-LICENSE.txt` y el hash en `fonts/README.md`), todo el color, tamaño, radio y espacio sale de `tokens.css`; fuera Source Serif 4 y el paquete `@fontsource-variable/source-serif-4`. Un test falla si el CSS escribe un color, una letra o una variable propia. |
| 3. Tienda | Inter autoalojada (`app/fonts/`, mismo archivo), sin Fraunces ni `next/font/google`. Naranja fuera: paleta de Notion (ver «Cambio de color»). Botones con `.btn`. Logotipo «Aule»: **SVG trazado de Fraunces** (peso 600, tamaño óptico 20, interletra −0,025 em; `components/logo.tsx`, reproducible con `design/trazar-logo.py`). No hizo falta dejar Fraunces. |
| 4. Copia en la tienda | `DESIGN.md` idéntico + `design/tokens.mjs` y `design/contrast.mjs` (los dos archivos que lo leen) + `design/DESIGN.lock.json` (hash, versión del formato, versión de la CLI, commit de origen). El test falla si cualquiera se mueve sin el lock. `npm run design-sync -- --from ../aule-sw` copia y reescribe el lock; `--verify` compara con una copia local de `aule-sw`. |
| 5. Contraste por pares | Hecho, en las dos copias: recorre cada componente con texto y fondo (36 pares; el más bajo, 4,57:1) y exige 4,5:1. Probado con el contraejemplo del retador (acento de fondo y de texto del mismo botón): falla. |
| 6. Antes y después | Hecho: `design/visual` (Playwright 1.65.0, publicada el 5 nov: 18 días; Chrome instalado, sin bajar navegador) en las dos ramas. Línea base «después» comprometida en `design/visual/base`. Copias en `~/aule-server/handoffs/reportes/capturas-diseno-20261123/` (`playground-` y `tienda-`, `antes`/`despues`, `escritorio-1440`/`movil-390`). |

Pruebas: `pnpm test` (aule-sw) 82/0 y `pnpm --filter @aule/playground typecheck` limpio; tienda: `npm run typecheck`, `lint`, `test` (35/0) y `build` limpios. El «antes» es el commit base de cada rama (`0c813cd` y `1d3b191`).

## Cambio de color (Cesar, propuesta §7): manda sobre lo anterior en color

Sin acento propio: la paleta es la de Notion (variables `--tatami-color-*` de `skilljar.css?v=32`, con la variable de origen al lado de cada token en `DESIGN.md`). Fuera el cobre, el naranja y los derivados.

- **Tokens:** `paper` #fff, `surface-neutral` #f6f5f4, `surface-hover` #0000000d, `ink` #000000e5, `muted` #0000008a, `line` #0000001a, `primary` #0075de, `primary-hover` #005bab, `secondary` #e6f3fe con `secondary-text` #005bab, `secondary-hover` #f2f9ff, `link-hover` #00396b, `danger` #b01601, `success` #0f6220. Un test los compara uno a uno y falla si queda `accent*`, `paper-deep`, `surface` o un `#9a5b2e`/`#cf5a1e`/`#e8a26b`.
- **Alfa:** la CLI acepta hex de 8 dígitos, así que `ink`, `muted`, `line` y `surface-hover` quedan **como los tiene Notion**, no compuestos sobre blanco. En `tokens.css` van tal cual; en `figma-*.json` llevan su hex de 8 y un campo `alpha` (p. ej. 0,898). La prueba de contraste compone el alfa sobre el fondo (y un fondo transparente sobre `paper`) antes de medir.
- **Reglas de contraste con prueba:** un enlace `#0075de` sobre `#f6f5f4` da 4,19:1, así que sobre gris va en `#005bab` (componente `link-on-neutral`, 6,25:1); la prueba comprueba las dos cosas. Encontré otra que no estaba en la propuesta: **`muted` sobre gris da 4,47:1**, así que solo va sobre blanco; la prueba falla si algún componente lo pone sobre gris. Los botones: principal 4,57:1, secundario 6,04:1.
- **esp32:** fuera #e8a26b. Botón `esp32-primary` #0075de con texto blanco (4,57:1), `esp32-text-accent` #62aef0 para texto y estado (8,83:1 sobre negro), todo lo demás igual (el borde deshabilitado #707070 se queda). Sigue sin usar la paleta web (solo repite el mismo azul del botón con su propio token).
- **e-ink:** sin cambios. **Logotipo de la tienda y fotos del aparato:** sin tocar (el naranja del aparato en las fotos sigue).
- **Playground:** sin el grano de papel (llevaba un color propio), fondo blanco, el avatar del encabezado en `currentColor`, `--accent*` pasa a `--primary`, `--secondary`, `--secondary-text`. El hover del botón quieto es `secondary-hover`.
- **Tienda:** `--color-surface` pasa a blanco (ya no hay «papel cálido» que distinguir) y los bloques en gris usan `surface-neutral`.

**Riesgos que veo (para decidir):**
1. **Los bordes de campos y tarjetas (`line`, negro al 10 %) dan 1,26:1 sobre blanco**, lejos de los 3:1 de WCAG 1.4.11 para el borde de un campo. Es lo que usa Notion, pero un campo de texto de un niño casi no se ve. Si se quiere cumplir, el borde de los campos tendría que ser más oscuro (otro token, que la propuesta no define).
2. Aule se ve ahora muy parecida a Notion (el riesgo de marca que ya anotó la propuesta).

## Decisiones mías que puedes revertir

1. **Los botones del playground pasan de negro a azul** (antes cobre; ver «Cambio de color»). El filled es `primary` con texto blanco; el botón quieto (por defecto) es `secondary` con `secondary-text`. Ya no hay píldoras: los chips también quedan en radio 8.
2. ~~Derivados del acento~~ Ya no hay: sin acento propio no hay `accent-tint` ni `accent-deep`, y se quitaron `--derive` y `pnpm design-derive`.
3. **Radios del playground:** 22 y 14 pasan a 16 y 12; campos 12 → 8; el resto se ajustó al más cercano de la escala. Hay un 10 (pantalla del aparato) que se queda.
4. **Playground:** título de página `headline-sm` (32/40) y de formulario `card-title` (22/28), no los 64/54 de Notion, que son de portada. Los rótulos en mayúsculas (11–13 px) pasan a 14 px porque 14 es el mínimo de la escala. El texto del tutor deja la serifa y va en Inter.
5. **Tienda:** el título de sección es 54/56 en escritorio (era 36), el héroe 64/64, el contenedor 1128 y los márgenes 24 (`px-6`). Los bordes `hairline` pasan de tinta al 8 % a `line` sólido (#c9c3b4). `text-lg` pasa a `.type-lead` (20/28; 16/24 en móvil). Las clases de espaciado vertical de Tailwind (`py-14`…) se quedaron: ya van en base de 4 y no son tokens.
6. **Interlineados en px** (24px, no 1.5): ver «Hallazgos de la CLI».
7. **Modos como prefijo** (`eink-`, `esp32-`), porque el formato no tiene modos. `esp32-` queda como propuesta hasta probarlo en la pantalla. **Corrección del arquitecto aplicada:** `esp32` no usa la paleta web: fondo negro #000, texto blanco y acento #e8a26b, objetivos de 150 px o más (`esp32-target`). Una cosa mía ahí: el botón es acento de fondo con texto negro (9,81:1; el encargo no decía cuál va de fondo). **Ajuste de arquitecto-2:** radio de 24 px fijo (`rounded.esp32-md`), borde de 4 px (`esp32-stroke`), separación mínima entre objetivos de 38 px (`esp32-target-gap`, nombrado como `esp32-target`, no `esp32-space-…`), y botón deshabilitado con texto blanco al 70 % (`esp32-white-70`, `#ffffffb3`) y borde de guiones `esp32-disabled` #707070, que solo se usa ahí. La prueba de contraste trata un componente `*-stroke` como gráfico (3:1, WCAG 1.4.11; este da 4,24:1) y compone la transparencia sobre el fondo antes de medir. El `lint` de la CLI mide todo como texto y avisa una vez de ese par: la prueba permite ese aviso y ninguno más. `figma-esp32.json` solo trae variables propias del modo.
8. **Formato de `figma-<modo>.json`:** una lista plana de variables (`color/…` COLOR, `space/…`, `radius/…`, `type/<estilo>/size|weight|line-height|letter-spacing` FLOAT en px, `type/<estilo>/family` STRING), pensada para crear las variables de Figma desde `use_figma`. **No lo probé en Figma** (no era mío).
9. **Identidad de git:** no hay `user.name` configurado en la Mac; los commits llevan la misma firma que los anteriores de la rama (Cesar, correo noreply de GitHub), puesta por variables de entorno en cada comando.

## Hallazgos de la CLI 0.4.0 (verificados en el código y con pruebas)

- Un `lineHeight` sin unidad (1.5) **desaparece del modelo** sin aviso, y también de las tres exportaciones. Por eso van en px.
- `export css-vars` y `css-tailwind` dejan fuera el interlineado y entrecomillan una pila completa de letras como si fuera un solo nombre; `dtcg` pierde la unidad del interlineado y `fontFeature`. El generador usa el modelo que arma `lint` (misma versión, sí trae todo) y deja el `lint` de la CLI como paso previo.
- El modelo acepta colores hex de 6 y de 8 dígitos (`#RRGGBBAA`), pero **el `lint` ignora el alfa** al medir contraste (`#0000000d` sobre `#000000e5` le sale 1,00:1): por eso `row-hover` solo lleva fondo y la prueba propia compone el alfa. No acepta `color-mix` (la especificación dice que sí).

## Lo que no pude o no hice

- **El playground en sesión no está capturado**, solo la página de entrada (como pedía el encargo). Reescribí `style.css` entero (botones, tarjetas, tablero, ruta, chips, mensajes) y lo único que miré con ojos es la entrada; lo demás lo cubren el test del CSS (sin colores ni variables propias) y `typecheck`. Falta una pasada visual de la sesión (necesita LiveKit).
- **Las líneas base visuales son de macOS** y no corren en CI (los píxeles cambian entre sistemas). Se corren a mano: `pnpm --filter @aule/design visual` y `npm run visual`.
- **El original y la copia se sincronizan a mano.** No hay CI entre repos privados: el lock detecta que la copia se movió, no que el original cambió después. `design-sync --verify ../aule-sw` lo comprueba cuando están las dos copias.
- **No corrí `docker build`** de la imagen del playground (la carpeta `public/fonts` entra por el `COPY` de `public`, y la prueba del servidor sirve la fuente y su licencia).
- **NotionInter no se comparó** glifo por glifo (no se descarga). Lo de e-ink con alumnos queda como dijo el retador.
- **Seguridad de npm:** 96 entradas nuevas en el lock de `aule-sw` y 91 en el de la tienda, todas con más de 14 días (comprobadas una por una con `npm view`). Tres dependencias indirectas de la CLI eran de ayer (20 nov) y quedan fijadas a la versión anterior con `overrides` en `pnpm-workspace.yaml`; se quitan pasado el 4 dic. La propia `pnpm` 12.21.0 (la que fija el repo) tiene 10 días: la usé como herramienta, no la añadí.
- No toqué el aparato, el Figma, Impeccable ni `main`.

## Qué va en cada commit

`aule-sw` `claude/diseno-unico`: `35decff` (DESIGN.md, generador y pruebas), `fa4b0b9` (playground con Inter y tokens), `c1ad06c` (capturas); más el de esta entrega. `aule-store` `claude/diseno-unico`: `7323313`, `e884ea3`, `5816616`, `d640a4e`.
