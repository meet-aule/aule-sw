# Especificación · demo web de Aule (desktop)

Reglas del encargo de Cesar, tal como se implementaron. **[PROPUESTA]** = aún sin confirmar por Cesar, va configurable
(en `crates/aule-core/src/config.rs`). Cada regla aparece en el código con su ID en un comentario y en el panel cuando se aplica.

## 1. Qué es

Aule es un tutor de IA: el producto real es un robot con pantalla e-ink, cámara y voz para el Alumno, y WhatsApp para el Padre de familia.
Esta demo es para desktop, vive en la web y muestra solo el flujo de aprendizaje dentro de una sesión: definir el Objetivo de la sesión,
medir el Nivel (Tamizaje), llevarlo al Nivel objetivo (Etapa 1 y Etapa 2) y luego hacer la Tarea, simular la Evaluación o corregirla.

No entran: consentimiento, registro, agenda, recordatorios, WhatsApp real, cuentas, pagos, metacognición, puntos y premios.

Vocabulario obligatorio: Aule, Alumno (nunca "niño"), Padre de familia, Docente, Evaluación (solo lo que mide el colegio),
Tarea (lo que deja el colegio), Tamizaje, Simulación, Objetivo de la sesión, Nivel, Nivel objetivo, "Etapa 1: Descubrimiento",
"Etapa 2: Refuerzo", Pistas, "Paso a paso de un ejercicio similar", Pausa activa, Informe, Aprendizaje extracurricular,
Next item correctness, Time-to-master.

**Regla de oro:** la IA nunca decide el flujo. La máquina de estados decide; la IA solo (a) redacta los mensajes de Aule,
(b) corrige respuestas y explicaciones con JSON estricto y (c) lee la foto del cuaderno.

## 2. Objetivo de la sesión

- **OBJ-05.** 4 tipos: Preparación para evaluación (se simula una Evaluación que viene), Tarea (con fecha límite), Corrección de evaluación (Evaluación real que ya sucedió) y Aprendizaje extracurricular (cuando no hay Tareas ni Evaluaciones).
- **OBJ-07.** Nivel objetivo por tipo. Preparación: el nivel más alto de las Tareas anteriores de ese tema. Tarea: el nivel que pide la Tarea. Corrección: el nivel que pedía la Evaluación, solo en los temas donde falló. Extracurricular: el nivel inmediato siguiente; con nivel 5 no hay más que enseñar en ese tema.
- **OBJ-06 / DEMO-02 [PROPUESTA].** En la demo, quien presenta carga los objetivos: tipo, curso, tema, fecha y Nivel objetivo.
- **OBJ-08.** Si la Tarea o Evaluación es de un curso o tema que no cubrimos, Aule lo dice con honestidad, se registra y sigue con el siguiente objetivo.
- **OBJ-09.** Con varios objetivos: primero la fecha más cercana; si coinciden, por tipo: Preparación, Tarea, Corrección, Extracurricular.
- **OBJ-10.** Sin fecha: se pregunta hasta conseguirla o hasta que digan que no hay.
- **OBJ-11.** Extracurricular aplica si no hay Tareas ni Evaluaciones, o si el Alumno termina el objetivo antes de los 30 minutos y no queda otro pendiente. Si la sesión no ha comenzado decide el Padre de familia (en la demo, una sugerencia cargada antes); si ya comenzó, el Alumno. Mismo tema ya avanzado: nivel inmediato superior. Solo temas de matemáticas mapeados; los intereses ambientan ejemplos y ejercicios.

## 3. Tamizaje

- **NIV-01.** Cada tema tiene 5 niveles de dificultad; el nivel es independiente por tema.
- **TAM-01.** 1 vez por tema, unos 15 minutos. Si ya se conoce el nivel, no se repite.
- **TAM-02.** 5 preguntas de dificultad progresiva, una por nivel. El Alumno hace las 5, sin reposiciones y sin Pistas.
- **TAM-03.** Queda en el último nivel consecutivo correcto. Bien, bien, mal, bien, bien = nivel 2. Mal, bien, bien, bien, bien = ningún nivel (aprende desde el 1).
- **TAM-04.** Cada pregunta pide respuesta y explicación; es correcta solo si las dos están bien.
- **TAM-05.** Aule baja la ansiedad ("Tranquilo, con calma", "No pasa nada si fallamos, estamos para aprender", "Tú puedes").
- **TAM-06.** El Alumno puede salir si se siente abrumado: queda en el último nivel consecutivo correcto y la sesión siguiente retoma desde ese mismo nivel con una pregunta distinta.
- **TAM-08.** El resultado y el plan van en el Informe. **[PROPUESTA]** Con un nivel por debajo del Nivel objetivo, Aule también le cuenta el plan al Alumno: qué va a reforzar antes del objetivo y para qué.

## 4. Sesión

- **SES-01.** Recomendado 1 hora; mínimo 30 minutos; máximo 1 hora y 30 minutos.
- **SES-02.** Si termina el objetivo antes de los 30 minutos, sigue con el siguiente pendiente; si no hay, Aprendizaje extracurricular.
- **SES-04.** Nunca un cierre abrupto: Aule avisa con n ejercicios de anticipación.
- **SES-05.** Sesión de 30 minutos: no se avisa. Más de 30 y hasta 1 hora: avisa faltando 2 ejercicios. Más de 1 hora y hasta 1 hora y 30: faltando 3. **[PROPUESTA]** La duración es la proyectada: tiempo transcurrido más el tiempo promedio de los ejercicios que faltan.
- **SES-06.** Si el objetivo no se va a completar en la sesión, avisa faltando 3 ejercicios para cumplir la 1 hora y 30. Los tiempos son referenciales.
- **SES-07.** Texto del aviso: "[nombre_alumno], por cierto, estos son nuestros últimos [2 o 3] ejercicios por hoy. Si te gustaría una sesión adicional dime cuándo te gustaría y se lo comento a tus padres".
- **HW-01.** En conversación, el Alumno responde por voz (producto real; en esta demo web se escribe: decisión de Cesar del 2026-11-15, sin voz en la primera demo). **HW-02.** En un ejercicio, lo resuelve en su cuaderno y Aule toma una foto cuando terminó.

## 5. Ruta

- **RUT-01.** Se compara el nivel del Alumno con el Nivel objetivo, tema por tema.
- **RUT-02.** Nivel igual o superior: directo a simular, hacer la Tarea o corregir.
- **RUT-03.** Nivel inferior: Etapa 1 del nivel inmediato siguiente, Etapa 2 de ese nivel, se repite hasta el Nivel objetivo, y recién ahí simula, hace la Tarea o corrige.
- **RUT-04.** Extracurricular: lo que sugirió el Padre de familia; si no, lo que el Alumno desee. Tema ya visto: Etapa 1 y 2 del nivel siguiente. Tema nuevo: primero Tamizaje.
- **RUT-05 a RUT-08.** Al llegar al nivel siguiente en extracurricular: quedan niveles y pasaron más de 30 min → termina; quedan y no pasaron 30 → sigue al siguiente nivel; no quedan y pasaron más de 30 → termina; no quedan y no pasaron 30 → pregunta qué otro tema le interesa, con una sugerencia.
- **RUT-09.** Con nivel 5 (o Tamizaje con 5): felicita por estar muy bien informado y pregunta qué otro tema le interesa, con una sugerencia según sus intereses.

## 6. Etapa 1: Descubrimiento

- **E1-01.** Aprende a resolver ejercicios del nivel inmediato siguiente.
- **E1-02.** Teoría que parte del nivel que ya alcanzó, sin abrumar con lo que ya sabe. Entre 5 y 10 minutos.
- **E1-03.** Ejemplos no asistidos (Aule explica la secuencia y ejecuta cada paso) y asistidos (Aule recuerda la secuencia; el Alumno ejecuta los pasos). **[PROPUESTA]** Si hace todos los pasos de un ejemplo asistido bien al primer intento y sin Pistas, pasa a explicarlo sin el ejemplo asistido siguiente.
- **E1-04.** Se completa cuando el Alumno explica con sus palabras de qué va el tema y concluyó los 2 tipos de ejemplos.
- **E1-05.** Si no logra explicarlo: la misma secuencia de Pistas; si las agota, repaso conceptual de ese tema en ese nivel.

## 7. Etapa 2: Refuerzo

- **E2-01.** 5 ejercicios autónomos del mismo nivel, desde diferentes ángulos. Aquí se mide el Next item correctness.
- **E2-02.** Se completa con los 5 correctos. **[PROPUESTA]** O antes, cuando los últimos 3 salen bien al primer intento y sin Pistas (`etapa2_aciertos_seguidos`); por eso Aule dice que son "hasta 5".
- **E2-03.** Si falla uno: Pistas; luego resuelve ese ejercicio, no los que ya hizo.
- **E2-04.** Si vuelve a fallar después de las Pistas y del Paso a paso de un ejercicio similar: vuelve a la Etapa 1 de ese mismo nivel.
- **E2-05.** Repetir un nivel no impide seguir hasta el Nivel objetivo.

## 8. Tarea, Simulación y Corrección

- **TAR-01.** Con el nivel, hace la Tarea él solo; Aule ayuda solo cuando se traba. **TAR-03.** Aule revisa cada respuesta. **TAR-04.** Si se traba: Pistas; si se agotan, Paso a paso de un ejercicio similar (nunca del mismo); luego reintenta su ejercicio.
- **PRE-02.** Estimación de sesiones: niveles que faltan × tiempo promedio por nivel, en sesiones de ~1 hora; sin historial, 1 nivel por sesión. En la demo solo se muestra.
- **PRE-08.** Simulación: n ejercicios por tema, sin Pistas; n = 2. **PRE-09.** Si falla: se compara su nivel con el de la pregunta que falló y va a Etapa 1 y Etapa 2. **PRE-10.** Luego se vuelve a simular solo donde falló, con ejercicios nuevos.
- **COR-02.** Los errores son normales y no se satanizan. **COR-03.** Nivel objetivo = el que pedía la Evaluación donde falló; si no se conoce su nivel, primero Tamizaje. **COR-04.** Los ejercicios de las etapas no son los de la Evaluación. **COR-05.** Con el nivel, vuelve a resolver solo lo que falló; si se traba, Pistas.

## 9. Pistas

- **PIS-01.** Se traba con 3 disparadores: aprieta "Necesito ayuda", se pasa del tiempo promedio del ejercicio, o responde mal. La primera respuesta incorrecta dispara las Pistas. **[PROPUESTA]** Sin tiempo promedio cargado, ese disparador queda apagado.
- **PIS-02.** Orden: 2 Pistas socráticas y verbales, luego 1 gráfica (configurable).
- **PIS-03.** Agotadas: Paso a paso de un ejercicio similar, nunca del mismo; luego reintenta el suyo.
- **PIS-04.** Hay Pistas en Etapa 1 (si no logra explicar), Etapa 2, Tarea y Corrección. No en el Tamizaje ni en la Simulación.
- **PIS-05.** Aule cuida lo emocional: el Alumno no debe relacionar su dificultad con su identidad.

## 10. Pausa activa

- **PAU-01 a PAU-03.** 30 minutos: ninguna. Más de 30 y hasta 1 hora: 1, a los 30 min. Más de 1 hora y hasta 1 h 30: 2, a los 30 min y a la hora.
- **PAU-04.** Aule nunca interrumpe un ejercicio ni su propia explicación: la pausa entra al terminar el ejercicio en curso.
- **PAU-05.** También entra antes si el Alumno aprieta "Estoy cansado".
- **PAU-06.** Dura 5 minutos. El Alumno elige 1 de 4 actividades: 2 energizantes (somnoliento o aburrido) y 2 relajantes (ansioso o frustrado). **[PROPUESTA]** las 4 actividades. Quien presenta puede saltarse la espera.

## 11. Cierre, métricas y datos

- **DEMO-09.** Al terminar, vista previa en pantalla del Informe que recibiría el Padre de familia por WhatsApp a las 8pm. No se envía nada. **INF-02:** un solo saludo y luego un mensaje por cada cosa que se hizo. Plantillas en `crates/aule-core/src/informe.rs` (tal cual; solo cambian los corchetes).
- **MET-01.** Next item correctness: en los 5 ejercicios de la Etapa 2, proporción bien al primer intento y sin Pistas. No cambia el flujo. Por tema y nivel, y también en la Simulación. **[PROPUESTA]** Con E2-02 la Etapa 2 puede terminar antes: se mide en los ejercicios que hizo.
- **MET-04.** Time-to-master: minutos desde que inicia la Etapa 1 de un nivel hasta completar los 5 de la Etapa 2, sin contar pausas. **MET-05.** Valor inicial: 1 nivel por sesión de 1 hora.
- **DAT-03.** Audio y foto: borrado inmediato. **DEMO-16 [PROPUESTA].** Nada se guarda en disco: el estado vive en memoria y se borra al reiniciar.
- **DEMO-15 [PROPUESTA].** "Sesión siguiente" conserva el nivel por tema, los objetivos sin completar y el Tamizaje incompleto.

## 12. Contenido

Matemáticas de 5to de primaria (Perú), tema Fracciones, 5 niveles:

1. Leer, escribir y representar fracciones: numerador, denominador, parte de un todo y de un conjunto.
2. Fracciones equivalentes, simplificar y comparar.
3. Suma y resta con igual denominador; números mixtos y fracciones impropias.
4. Suma y resta con distinto denominador.
5. Problemas de varios pasos: fracción de una cantidad y operaciones combinadas.

Por nivel: 2 preguntas de Tamizaje, Etapa 1 completa (teoría, 2 ejemplos no asistidos y 2 asistidos, pregunta para explicar con criterio,
Pistas y repaso), 10 ejercicios de Etapa 2 en 5 ángulos (gráfica, cálculo, contexto, encontrar el error o V/F, dato faltante o inverso),
4 de Simulación. Además, una Tarea de 5 ejercicios, una Evaluación de ejemplo para la Corrección y contextos por intereses
(fútbol, videojuegos, dinosaurios, cocina, música y neutro) con los mismos números. Todo es **[PROPUESTA]** (ver PENDIENTES).

## 13. Experiencia

Inicio con Alumno, intereses, Padre de familia y ajustes rápidos; vista del Alumno tipo papel/e-ink con el ejercicio grande,
fracciones tipografiadas y gráficos SVG; "Necesito ayuda" y "Estoy cansado" siempre a mano; progreso discreto; todo por escrito (sin voz en esta primera demo, decisión de Cesar del 2026-11-15); cámara con guía de encuadre, subir foto y "Escribir mi respuesta";
panel de quien presenta (lateral y en `/panel`); cierre con aviso, despedida, Informe y métricas; nunca esperando en silencio.

## 14. Experiencia (2026-11-15)

Pedido de Cesar: "enfócate en que la experiencia sea extremadamente buena (intuitiva y fácil de entender)" y "ya no coloques nada de voz en esta primera demo. Lo que quiero testear es el flujo, el proceso."

- Una sola acción principal por momento; el ejercicio con su recuadro de respuesta en una sola tarjeta.
- Mapa de la sesión arriba, tarjeta corta de transición entre etapas, explicación de una línea de cada término la primera vez que aparece.
- Pistas visibles junto al ejercicio ("Pista 1", "Pista 2", dibujo, "Mira cómo se hace uno parecido").
- Chat como acompañante: separadores "Pregunta 2 de 5" en vez de burbujas sueltas.
- Sin voz: ni micrófono ni síntesis.
