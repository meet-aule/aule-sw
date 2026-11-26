# Formato del banco de contenido (Fracciones, 5to de primaria)

Todo el contenido es **[PROPUESTA]**: lo escribió Claude para la demo y el equipo debe refinarlo.
Los tipos están en `crates/aule-core/src/banco.rs`. La validación (`cargo test -p contenido`)
comprueba cada respuesta con el tipo `Fraccion`.

Archivos: `nivel1.toml` … `nivel5.toml` (un nivel cada uno) y `extras.toml` (tareas, evaluación, intereses).

## Reglas de redacción

- Español de Perú, de tú, frases cortas, para un Alumno de 10 a 11 años. Nunca "niño": "Alumno".
- Fracciones en texto como `3/4` (la interfaz las tipografía como numerador sobre denominador).
  Números mixtos como `1 1/2`. Multiplicar con `×`. No uses LaTeX ni HTML.
- Pistas socráticas: **preguntas** que guían sin dar la respuesta (deben llevar `?`).
- La pista gráfica tiene un `texto` corto y un `grafico`.
- El `similar` usa **otros números** que el ejercicio, y su paso a paso resuelve el similar (nunca el del alumno).
- `contextos`: enunciados ambientados por interés (`futbol`, `videojuegos`, `dinosaurios`, `cocina`, `musica`) con **los mismos números**
  (el validador compara las cifras). El `enunciado` es el neutro. Ponlos en los ejercicios de ángulo `contexto` (los 5 intereses) y donde aporte.
- `verificar`: expresión con enteros, `+ - * /`, paréntesis y opcionalmente una comparación `< > = <= >=`.
  - Respuesta numérica: `verificar` debe dar el mismo valor (`respuesta = "11/12"`, `verificar = "3/4 + 1/6"`).
  - Con `opciones`: `verificar` es una comparación que da **verdadero**, o **falso** si la respuesta es `"Falso"`.
    Si las opciones son símbolos `<`, `>`, `=`, la comparación usa el mismo símbolo de la respuesta.
- `forma`: `cualquiera` (por defecto), `simplificada`, `mixto`, `impropia`, `entero`. La `respuesta` canónica debe escribirse en esa forma.
- `tiempo_s`: tiempo promedio razonable para un Alumno de 5to (60–240 s normalmente).
- Gráficos (`tipo`): `barra {partes, sombreadas, etiqueta?}`, `barras {filas=[{partes, sombreadas, etiqueta?}]}`,
  `circulo {partes, sombreadas}`, `circulos {partes, sombreadas}` (varios círculos, para impropias/mixtos; máx. 4 círculos),
  `recta {desde=0, hasta, divisiones, marca?="a/b", pregunta?=true}` (divisiones por unidad; máx 40 marcas),
  `conjunto {total, marcados, icono?="⚽"}` (máx 30).
- Ángulos de Etapa 2 (`angulo`): `grafica`, `calculo`, `contexto`, `error` (encontrar el error o V/F con justificación; normalmente `pide_explicacion = true`), `inverso` (dato faltante o problema inverso). Mínimo 2 por ángulo, 10 ejercicios en total por nivel.
- Si `pide_explicacion = true`: `criterio_explicacion` (qué cuenta como buena explicación, para la IA) y `claves_explicacion`
  (grupos de palabras para el respaldo sin IA; cuenta si toca `minimo_claves` grupos; usa raíces cortas como `"simplific"`, `"mismo denominador"`).
- `nombre_corto` (en cada nivel): cómo lo dice Aule en voz alta al contar el plan, en pocas palabras (máximo 8) y con artículo,
  porque va en una lista con otros niveles: `"las fracciones equivalentes"`. `titulo` es para la pantalla y `subtema` para el informe.
- Tamizaje: 2 preguntas por nivel (la segunda para retomar). Siempre piden respuesta **y** explicación. Sin pistas.
- Simulación: al menos 4 por nivel (2 para simular + 2 repuestos para volver a simular con ejercicios nuevos). Sin pistas.

## Ejemplo (estructura de un nivel)

```toml
nivel = 3
titulo = "Suma y resta con igual denominador; mixtos e impropias"
subtema = "sumar y restar fracciones con igual denominador"
nombre_corto = "las sumas y restas con el mismo denominador"

[[tamizaje]]
id = "n3-t1"
enunciado = "Calcula 2/7 + 3/7. Luego explica cómo lo hiciste."
respuesta = "5/7"
verificar = "2/7 + 3/7"
criterio_explicacion = "Dice que el denominador se mantiene (son partes del mismo tamaño) y que se suman los numeradores."
claves_explicacion = [["numerador", "arriba"], ["mismo denominador", "denominador igual", "se queda", "se mantiene", "no cambia"]]
minimo_claves = 2
tiempo_s = 90

[etapa1]
[[etapa1.teoria]]
texto = "Ya sabes que 3/7 son 3 partes de un todo partido en 7 partes iguales..."
grafico = { tipo = "barra", partes = 7, sombreadas = 3 }

[[etapa1.no_asistidos]]
enunciado = "Calculemos 1/5 + 2/5."
pasos = ["Miro los denominadores: los dos son 5, son quintos.", "Sumo los numeradores: 1 + 2 = 3.", "Dejo el denominador: 3/5."]
respuesta = "3/5"
verificar = "1/5 + 2/5"

[[etapa1.asistidos]]
enunciado = "Ahora tú: 4/9 + 2/9."
secuencia = ["Mirar los denominadores", "Sumar los numeradores", "Dar el resultado"]
respuesta = "6/9"
verificar = "4/9 + 2/9"
[[etapa1.asistidos.pasos]]
indicacion = "Paso 1: ¿los denominadores son iguales? Responde sí o no."
respuesta = "Sí"
opciones = ["Sí", "No"]
ayuda = "¿Qué número hay abajo en cada fracción?"
solucion = "Los dos tienen 9 abajo, así que sí son iguales."
[[etapa1.asistidos.pasos]]
indicacion = "Paso 2: suma los numeradores. ¿Cuánto es 4 + 2?"
respuesta = "6"
ayuda = "¿Cuánto tienes si juntas 4 y 2?"
solucion = "4 + 2 = 6."
[[etapa1.asistidos.pasos]]
indicacion = "Paso 3: escribe el resultado como fracción."
respuesta = "6/9"
ayuda = "¿Qué numerador te salió y qué denominador se queda?"
solucion = "El resultado es 6/9."

[etapa1.explicar]
pregunta = "Con tus propias palabras: ¿cómo se suman dos fracciones que tienen el mismo denominador?"
criterio = "Explica que se suman los numeradores y el denominador queda igual porque las partes son del mismo tamaño."
claves = [["numerador", "arriba"], ["denominador", "abajo"], ["igual", "mismo", "se queda", "no cambia", "se mantiene"]]
minimo_claves = 2
pistas = ["Si tienes 2 pedazos de pizza de octavos y te dan 3 pedazos más de octavos, ¿cuántos pedazos tienes?", "¿Esos pedazos cambiaron de tamaño al juntarlos?"]
pista_grafica = { texto = "Mira: 2/8 y 3/8 juntos.", grafico = { tipo = "barras", filas = [{ partes = 8, sombreadas = 2 }, { partes = 8, sombreadas = 3 }, { partes = 8, sombreadas = 5 }] } }

[[etapa1.repaso]]
texto = "Repasemos con calma..."

[[ejercicios]]
id = "n3-e01"
angulo = "contexto"
enunciado = "Ana leyó 2/8 de un libro el lunes y 3/8 el martes. ¿Qué parte del libro leyó en total?"
contextos = { futbol = "...2/8...3/8...", videojuegos = "...", dinosaurios = "...", cocina = "...", musica = "..." }
respuesta = "5/8"
verificar = "2/8 + 3/8"
tiempo_s = 120
pistas = ["¿Las dos partes son del mismo tamaño, o sea, tienen el mismo denominador?", "Si juntas 2 pedazos y 3 pedazos iguales, ¿cuántos pedazos tienes?"]
pista_grafica = { texto = "Pinta 2 octavos y luego 3 octavos más en la misma barra.", grafico = { tipo = "barras", filas = [{ partes = 8, sombreadas = 2, etiqueta = "lunes" }, { partes = 8, sombreadas = 3, etiqueta = "martes" }] } }
[ejercicios.similar]
enunciado = "Beto pintó 1/6 de una pared en la mañana y 4/6 en la tarde. ¿Qué parte pintó?"
pasos = ["Los denominadores son iguales: sextos.", "Sumo los numeradores: 1 + 4 = 5.", "El resultado es 5/6 de la pared."]
respuesta = "5/6"
verificar = "1/6 + 4/6"

[[simulacion]]
id = "n3-s1"
enunciado = "..."
respuesta = "..."
verificar = "..."
tiempo_s = 120
```

`extras.toml` lleva `curso`, `tema`, `grado`, `[[tareas]]` (con `id`, `titulo`, `nivel`, y 5 `[[tareas.ejercicios]]` completos con `nivel` explícito),
`[[evaluaciones]]` (con `[[evaluaciones.preguntas]]` que tienen `respuesta_alumno`, `fallada` y `[evaluaciones.preguntas.ejercicio]`)
e `[[intereses]]` (`clave`, `nombre`, `palabras`, `sugerencia`).
