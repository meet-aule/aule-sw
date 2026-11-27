//! Conversación libre con Aule (chat general). La IA conversa y devuelve una
//! intención estructurada; el motor decide qué hacer con ella. Aquí está el
//! respaldo determinista: clasificador de intenciones, glosario del tema y
//! respuestas variadas (nunca la misma frase dos veces seguidas).
//!
//! Regla pedida por Cesar (2026-11-15): el Alumno puede pedir que Aule aclare el
//! vocabulario del enunciado en cualquier momento, también en el Tamizaje; no cuenta como pista.

use crate::texto::{contiene_palabra, es_no_se, leer_fraccion, normalizar};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intencion {
    /// Pregunta qué significa una palabra o concepto (no es pista).
    AclararPalabra,
    /// Pide que se repita o explique el enunciado.
    RepetirEnunciado,
    /// Saludo, comentario, algo fuera de tema.
    Charla,
    /// Dice que está cansado (Aule sugiere el botón, no lo activa solo).
    EstoyCansado,
    /// "No entiendo nada", "esto es difícil".
    NoEntiendoNada,
    /// Escribió lo que parece la respuesta del ejercicio en el chat.
    RespuestaAlEjercicio,
    /// Pide ayuda para resolver (en etapas/tarea → sistema de pistas).
    PedirAyuda,
    /// Pide directamente la respuesta.
    PedirRespuesta,
}

impl Intencion {
    pub fn desde_str(s: &str) -> Option<Intencion> {
        serde_json::from_value(serde_json::Value::String(s.trim().to_string())).ok()
    }
    pub fn nombre(&self) -> &'static str {
        match self {
            Intencion::AclararPalabra => "aclarar_palabra",
            Intencion::RepetirEnunciado => "repetir_enunciado",
            Intencion::Charla => "charla",
            Intencion::EstoyCansado => "estoy_cansado",
            Intencion::NoEntiendoNada => "no_entiendo_nada",
            Intencion::RespuestaAlEjercicio => "respuesta_al_ejercicio",
            Intencion::PedirAyuda => "pedir_ayuda",
            Intencion::PedirRespuesta => "pedir_respuesta",
        }
    }
    pub const TODAS: [Intencion; 8] = [
        Intencion::AclararPalabra,
        Intencion::RepetirEnunciado,
        Intencion::Charla,
        Intencion::EstoyCansado,
        Intencion::NoEntiendoNada,
        Intencion::RespuestaAlEjercicio,
        Intencion::PedirAyuda,
        Intencion::PedirRespuesta,
    ];
}

/// Qué puede y qué no puede hacer Aule en este momento de la sesión.
#[derive(Clone, Debug, Serialize)]
pub struct ContextoChat {
    /// "Tamizaje · Pregunta 2 de 5", "Etapa 2: Refuerzo · Ejercicio 3 de 5"...
    pub momento: String,
    /// Enunciado del ejercicio o paso en pantalla (si hay).
    pub enunciado: Option<String>,
    /// En este momento hay pistas (Etapa 1 al explicar, Etapa 2, Tarea, Corrección).
    pub hay_pistas: bool,
    /// Tamizaje o Simulación: sin ayuda sobre cómo resolver.
    pub sin_ayuda: bool,
    pub en_tamizaje: bool,
    pub en_pausa: bool,
    /// Segundos que faltan de la Pausa activa (si hay).
    pub pausa_restante_s: Option<u64>,
    pub terminada: bool,
}

impl ContextoChat {
    /// Reglas para la IA, en lenguaje claro.
    // Instructions for the model are English; the engine's spoken lines stay localized.
    pub fn reglas(&self) -> String {
        let mut r = vec![
            "Never give the current exercise's answer, its solution steps, or solve it yourself. Do not call pose_exercise or check_answer: the session engine owns this exercise.".to_string(),
            "If asked what a word or concept means (such as simplify, numerator or equivalent), give a short explanation and an example with DIFFERENT numbers and a different result from the current exercise, then return naturally to it. This is not a hint and is always allowed, including during screening.".to_string(),
            "If they seem to give an exercise answer, do not judge it or say whether it is correct: naturally ask them to repeat it with their reasoning, or show their notebook.".to_string(),
            "Set no task of your own: never ask the student to count, compute or solve anything, and ask nothing that has a right answer; the session engine asks every such question. If the student answers something you asked, or something from an earlier step, do not judge it and do not return to it: the only step there is, is the current one.".to_string(),
            "If they are tired, acknowledge it warmly; the engine proposes breaks, not you.".to_string(),
            "For greetings, chatter or off-topic talk, respond warmly in one short line and return to the exercise.".to_string(),
            "If they repeat a question or say 'what?', rephrase more simply; never repeat a sentence you already said.".to_string(),
        ];
        if self.sin_ayuda {
            r.push(format!(
                "This is {}: no help with solving is allowed. If they ask for help or the answer, explain warmly that you want to see their own thinking{}, and offer to clarify any word in the statement.",
                if self.en_tamizaje { "screening" } else { "a simulation" },
                if self.en_tamizaje { "; remind them they may leave screening if overwhelmed" } else { "" }
            ));
        } else if self.hay_pistas {
            r.push("If they ask for help solving or for the answer, respond with one brief, warm acknowledgement: the system supplies the hint immediately after your message; do not give it yourself.".into());
        }
        if self.en_pausa {
            r.push(format!(
                "This is an active break ({} remaining): chat calmly and encourage movement or breathing; do not discuss exercises.",
                self.pausa_restante_s.map(minutos).unwrap_or_else(|| "a few minutes".into())
            ));
        }
        if self.terminada {
            r.push("The session has ended: chat briefly and say a warm goodbye.".into());
        } else {
            r.push("The session is not over until the session engine ends it. Never say goodbye, never say or hint that the session is finished or that it is enough for today, and never send the student away to rest, to their homework or to another day. If the student wants to stop, acknowledge it warmly in one line; the engine decides what happens next.".into());
        }
        r.join("\n- ")
    }
}

fn minutos(s: u64) -> String {
    match (s / 60, s % 60) {
        (0, x) => format!("{x} seconds"),
        (1, 0) => "1 minute".into(),
        (m, 0) => format!("{m} minutes"),
        (m, x) => format!("{m} min {x} s"),
    }
}

pub struct Termino {
    pub palabras: &'static [&'static str],
    pub nombre: &'static str,
    pub definicion: &'static str,
    /// Ejemplos con números; se elige uno que no use los números del ejercicio.
    pub ejemplos: &'static [&'static str],
}

pub const GLOSARIO: &[Termino] = &[
    Termino {
        palabras: &["simplific", "simplifica", "forma mas simple", "mas simple", "reducir", "irreducible"],
        nombre: "simplificar",
        definicion: "Simplificar es escribir la misma fracción con números más chiquitos: divides el número de arriba y el de abajo entre el mismo número. La cantidad no cambia.",
        ejemplos: &["Por ejemplo, 4/10 → divides los dos entre 2 y queda 2/5.", "Por ejemplo, 9/12 → divides los dos entre 3 y queda 3/4.", "Por ejemplo, 10/15 → divides los dos entre 5 y queda 2/3."],
    },
    Termino {
        palabras: &["numerador", "el de arriba", "numero de arriba"],
        nombre: "numerador",
        definicion: "El numerador es el número de arriba de la fracción: dice cuántas partes tomas.",
        ejemplos: &["En 2/7, el numerador es 2: tomas 2 partes.", "En 5/9, el numerador es 5: tomas 5 partes."],
    },
    Termino {
        palabras: &["denominador", "el de abajo", "numero de abajo"],
        nombre: "denominador",
        definicion: "El denominador es el número de abajo: dice en cuántas partes iguales se partió el todo.",
        ejemplos: &["En 3/10, el denominador es 10: el todo se partió en 10 partes iguales.", "En 1/6, el denominador es 6: hay 6 partes iguales."],
    },
    Termino {
        palabras: &["equivalent"],
        nombre: "fracciones equivalentes",
        definicion: "Dos fracciones son equivalentes cuando valen lo mismo aunque se escriban distinto: pintan la misma cantidad.",
        ejemplos: &["Por ejemplo, 1/3 y 2/6 son equivalentes.", "Por ejemplo, 2/5 y 4/10 son equivalentes."],
    },
    Termino {
        palabras: &["mixto"],
        nombre: "número mixto",
        definicion: "Un número mixto tiene una parte entera y una fracción juntas.",
        ejemplos: &["Por ejemplo, 2 1/3 son 2 enteros y un tercio.", "Por ejemplo, 1 2/5 es 1 entero y dos quintos."],
    },
    Termino {
        palabras: &["impropia"],
        nombre: "fracción impropia",
        definicion: "Una fracción impropia tiene el número de arriba igual o más grande que el de abajo: vale un entero o más.",
        ejemplos: &["Por ejemplo, 7/5 es impropia: es más que un entero.", "Por ejemplo, 9/4 es impropia."],
    },
    Termino {
        palabras: &["propia"],
        nombre: "fracción propia",
        definicion: "Una fracción propia tiene el número de arriba más chico que el de abajo: vale menos de un entero.",
        ejemplos: &["Por ejemplo, 3/7 es propia.", "Por ejemplo, 2/9 es propia."],
    },
    Termino {
        palabras: &["denominador comun", "mcm", "minimo comun multiplo", "comun multiplo"],
        nombre: "denominador común",
        definicion: "El denominador común es un número que está en la tabla de los dos denominadores; sirve para que las partes sean del mismo tamaño.",
        ejemplos: &["Por ejemplo, para tercios y cuartos sirve 12, porque está en la tabla del 3 y en la del 4.", "Por ejemplo, para medios y quintos sirve 10."],
    },
    Termino {
        palabras: &["fraccion", "fracciones"],
        nombre: "fracción",
        definicion: "Una fracción dice qué parte de un todo tomas, cuando el todo está partido en partes iguales.",
        ejemplos: &["Por ejemplo, 3/5 de una barra: la partes en 5 y tomas 3.", "Por ejemplo, 1/4 de una pizza es un pedazo de los 4."],
    },
    Termino {
        palabras: &["comparar", "mayor", "menor"],
        nombre: "comparar fracciones",
        definicion: "Comparar es ver cuál fracción es más grande. Si tienen el mismo denominador, gana la que tiene más partes.",
        ejemplos: &["Por ejemplo, 5/9 es mayor que 2/9.", "Por ejemplo, 7/10 es mayor que 3/10."],
    },
    Termino {
        palabras: &["de una cantidad", "fraccion de"],
        nombre: "fracción de una cantidad",
        definicion: "La fracción de una cantidad es repartir la cantidad en partes iguales y tomar algunas.",
        ejemplos: &["Por ejemplo, 2/5 de 10: repartes 10 en 5 grupos de 2 y tomas 2 grupos.", "Por ejemplo, 1/3 de 9 es 3."],
    },
];

fn numeros(s: &str) -> Vec<String> {
    let mut v = vec![];
    let mut cur = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            cur.push(c);
        } else if !cur.is_empty() {
            v.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        v.push(cur);
    }
    v
}

/// Busca el término del glosario por el que pregunta (el más específico).
pub fn buscar_termino(texto: &str) -> Option<&'static Termino> {
    let n = normalizar(texto);
    GLOSARIO
        .iter()
        .filter_map(|t| {
            t.palabras
                .iter()
                .filter(|p| contiene_palabra(&n, p))
                .map(|p| p.len())
                .max()
                .map(|l| (l, t))
        })
        .max_by_key(|(l, _)| *l)
        .map(|(_, t)| t)
}

/// Fracciones "a/b" que aparecen en un texto, por valor.
fn valores(s: &str) -> Vec<crate::fraccion::Fraccion> {
    s.split(|c: char| !(c.is_ascii_digit() || c == '/'))
        .filter_map(|w| {
            let (a, b) = w.split_once('/')?;
            crate::fraccion::Fraccion::try_new(a.parse().ok()?, b.parse().ok()?)
        })
        .collect()
}

/// Un ejemplo del término que no use los números del ejercicio ni llegue a un
/// valor que aparezca en él (así no regala la respuesta: 9/12 → 3/4 delata 6/8 → 3/4).
pub fn ejemplo_distinto(t: &Termino, enunciado: Option<&str>, variante: usize) -> &'static str {
    let usados = enunciado.map(numeros).unwrap_or_default();
    let valores_ej = enunciado.map(valores).unwrap_or_default();
    let validos: Vec<&&str> = t
        .ejemplos
        .iter()
        .filter(|e| !numeros(e).iter().any(|x| usados.contains(x)))
        .filter(|e| !valores(e).iter().any(|v| valores_ej.contains(v)))
        .collect();
    match validos.len() {
        0 => t.ejemplos[variante % t.ejemplos.len()],
        k => validos[variante % k],
    }
}

fn es_pregunta(n: &str, original: &str) -> bool {
    original.contains('?')
        || original.contains('¿')
        || [
            "que ", "como ", "por que", "porque ", "cual ", "cuando ", "donde ", "quien ",
        ]
        .iter()
        .any(|p| n.starts_with(p))
}

/// Clasificador determinista (respaldo sin IA).
pub fn clasificar(texto: &str) -> Intencion {
    let n = normalizar(texto);
    let pregunta = es_pregunta(&n, texto);
    let pide_significado = n.contains("significa")
        || n.contains("que es ")
        || n.contains("que era")
        || n.contains("que son ")
        || n.contains("a que se refiere")
        || n.contains("recuerda")
        || n.contains("recordar");
    if pide_significado && buscar_termino(texto).is_some() {
        return Intencion::AclararPalabra;
    }
    if n.contains("cansad") || n.contains("sueno") || n.contains("aburrid") {
        return Intencion::EstoyCansado;
    }
    if n.contains("respuesta")
        && (n.contains("dime") || n.contains("dame") || n.contains("cual es"))
    {
        return Intencion::PedirRespuesta;
    }
    if n.contains("ayuda")
        || n.contains("pista")
        || n.contains("ayudame")
        || n.contains("como lo hago")
        || n.contains("como se hace")
    {
        return Intencion::PedirAyuda;
    }
    if n.contains("repite")
        || n.contains("repetir")
        || n.contains("otra vez el")
        || n.contains("lee") && n.contains("pregunta")
    {
        return Intencion::RepetirEnunciado;
    }
    if n.contains("no entiendo nada")
        || n.contains("muy dificil")
        || n.contains("no entiendo")
        || (es_no_se(texto) && !pregunta)
    {
        return Intencion::NoEntiendoNada;
    }
    if pide_significado || (pregunta && buscar_termino(texto).is_some()) {
        return Intencion::AclararPalabra;
    }
    let palabras = n.split_whitespace().count();
    if !pregunta
        && leer_fraccion(texto).is_some()
        && (palabras <= 3 || texto.contains('/'))
        && palabras <= 6
    {
        return Intencion::RespuestaAlEjercicio;
    }
    Intencion::Charla
}

/// Respuesta del respaldo (sin IA) según la intención. `variante` cambia la frase
/// para no repetir; `ctx` decide qué se puede decir en este momento.
pub fn respuesta_guion(
    i: Intencion,
    texto: &str,
    ctx: &ContextoChat,
    variante: usize,
    alumno: &str,
) -> String {
    let v = variante;
    let elegir = |xs: &[&str]| xs[v % xs.len()].to_string();
    let volver = if ctx.en_pausa || ctx.terminada {
        String::new()
    } else {
        elegir(&[
            " Ahora sí, sigamos con tu ejercicio.",
            " Vuelve a mirar el ejercicio con esa idea.",
            " ¿Le das otra mirada a tu ejercicio?",
            " Cuando quieras, seguimos.",
        ])
    };
    match i {
        Intencion::AclararPalabra => match buscar_termino(texto) {
            Some(t) => {
                let ej = ejemplo_distinto(t, ctx.enunciado.as_deref(), v);
                let intro = elegir(&["Te lo recuerdo:", "¡Buena pregunta!", "Claro:", "Te lo cuento más simple:"]);
                format!("{intro} {} {ej}{volver}", t.definicion)
            }
            None => elegir(&[
                "¿Qué palabra del ejercicio no te queda clara? Dímela y te la explico.",
                "Dime qué palabra te confunde y te la explico con otro ejemplo.",
                "Cuéntame cuál es la palabra difícil y la vemos juntos.",
            ]),
        },
        Intencion::RepetirEnunciado => match &ctx.enunciado {
            Some(e) => format!("{} {e}", elegir(&["Claro, te lo leo otra vez:", "Va de nuevo:", "Te lo repito despacito:"])),
            None => elegir(&["Ahora no hay un ejercicio en pantalla, pero dime qué quieres que repita.", "¿Qué parte quieres que repita?"]),
        },
        Intencion::EstoyCansado => elegir(&[
            "Te entiendo, aprender cansa. Si quieres, hacemos una Pausa activa: dime «hagamos la pausa».",
            "Gracias por decírmelo. Cuando quieras, dime «hagamos la pausa» y descansamos un ratito.",
            "Está bien sentirse así. Si quieres, hacemos una pausa para movernos un poco.",
        ]),
        Intencion::NoEntiendoNada => {
            if ctx.sin_ayuda {
                elegir(&[
                    "No pasa nada, tranquilo. Dime qué palabra no entiendes y te la explico. Si te sientes abrumado, podemos dejar estas preguntas.",
                    "Está bien no saber todo. Si alguna palabra del ejercicio te confunde, pregúntame. Haz tu mejor intento, sin presión.",
                ])
            } else {
                elegir(&[
                    "Tranquilo, vamos paso a paso. Si quieres una pista, pídemela.",
                    "Es normal que cueste al principio. Dime qué palabra no entiendes, o pídeme una pista.",
                    "No pasa nada, para eso estoy. ¿Qué parte te confunde?",
                ])
            }
        }
        Intencion::RespuestaAlEjercicio => elegir(&[
            "¡Veo que tienes una respuesta! Dímela otra vez con cómo la pensaste, o muéstrame tu cuaderno, así la reviso.",
            "Para revisarla, dime tu respuesta y cómo llegaste a ella, o muéstrame tu hoja.",
            "Cuéntame tu respuesta y cómo la pensaste, y la revisamos juntos.",
        ]),
        Intencion::PedirAyuda | Intencion::PedirRespuesta => {
            if ctx.sin_ayuda {
                let salir = if ctx.en_tamizaje {
                    " Si te sientes abrumado, puedes salir del Tamizaje."
                } else {
                    ""
                };
                format!(
                    "{}{salir} Pero si una palabra del enunciado no se entiende, te la explico.",
                    elegir(&[
                        "Aquí no te puedo ayudar a resolverlo, porque quiero ver cómo lo piensas tú, y eso está muy bien.",
                        "En esta parte no hay ayuda: me importa ver tu forma de pensar, aunque te equivoques.",
                    ])
                )
            } else if ctx.hay_pistas {
                elegir(&["¡Claro, te doy una pista!", "¡Va una pista!", "Te ayudo con una pregunta."])
            } else {
                elegir(&["Estoy aquí contigo. ¿Qué parte te confunde?", "Cuéntame dónde te trabaste."])
            }
        }
        Intencion::Charla if ctx.en_pausa => {
            let n = normalizar(texto);
            let falta = ctx.pausa_restante_s.map(minutos).unwrap_or_else(|| "unos minutos".into());
            let saludo = ["hola", "buenas", "hey"].iter().any(|x| n.starts_with(x));
            if saludo {
                format!("¡Hola, {alumno}! Estamos en la Pausa activa: faltan {falta} para volver.")
            } else if n.contains("falta") || n.contains("cuanto") || n.contains("tiempo") || n.contains("volver") {
                format!("Nos quedan {falta} de pausa. {}", elegir(&["Aprovecha para estirarte.", "Respira hondo mientras tanto.", "Muévete un poquito, que hace bien."]))
            } else {
                format!("{} Faltan {falta} para volver.", elegir(&["¡Qué bueno!", "Me alegra.", "Así me gusta.", "Te escucho."]))
            }
        }
        Intencion::Charla => {
            let n = normalizar(texto);
            let saludo = ["hola", "buenas", "buenos dias", "buenas tardes", "hey"].iter().any(|s| n.starts_with(s));
            let gracias = n.contains("gracias") || n.contains("chau") || n.contains("adios");
            if saludo {
                format!("¡Hola, {alumno}! Qué bueno que estás aquí.{volver}")
            } else if gracias {
                format!(
                    "{}{}",
                    elegir(&["¡De nada, {a}!", "¡Con gusto, {a}!", "¡Para eso estoy, {a}!"]).replace("{a}", alumno),
                    if ctx.terminada { " Nos vemos en la próxima sesión." } else { " Todavía nos queda un poquito: sigamos juntos." }
                )
            } else if n == "que" || n == "eh" || n == "como" || n.len() <= 4 {
                elegir(&[
                    "Perdón, no fui claro. Dime con otras palabras qué necesitas y te ayudo.",
                    "Te lo digo de otra forma: estoy aquí para aclararte cualquier palabra del ejercicio. ¿Cuál te confunde?",
                    "A ver, más simple: si algo no se entiende, pregúntame qué significa y te lo explico.",
                ])
            } else {
                format!(
                    "{}{volver}",
                    elegir(&["¡Qué interesante!", "¡Me gusta que me cuentes!", "¡Ja, buena esa!", "Te escucho."])
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(tamizaje: bool) -> ContextoChat {
        ContextoChat {
            momento: "Tamizaje · Pregunta 2 de 5".into(),
            enunciado: Some("Simplifica 6/8 hasta su forma más simple.".into()),
            hay_pistas: !tamizaje,
            sin_ayuda: tamizaje,
            en_tamizaje: tamizaje,
            en_pausa: false,
            pausa_restante_s: None,
            terminada: false,
        }
    }

    #[test]
    fn instrucciones_del_modelo_por_etapa() {
        let screening = ctx(true);
        let rules = screening.reglas();
        assert!(rules.contains("This is screening: no help with solving is allowed"));
        assert!(rules.contains("may leave screening if overwhelmed"));
        assert!(rules.contains("Do not call pose_exercise or check_answer"));
        assert!(rules.contains("different result from the current exercise"));
        // The session is the engine's to end: the model never closes it.
        assert!(rules.contains(
            "The session is not over until the session engine ends it. Never say goodbye"
        ));
        assert!(!rules.contains("The session has ended"));
        // The model sets no exercise of its own and does not go back to an earlier step.
        assert!(rules.contains(
            "Set no task of your own: never ask the student to count, compute or solve anything"
        ));
        assert!(rules.contains("the only step there is, is the current one"));
        // Student-facing data is not translated or copied into the policy.
        assert!(!rules.contains(screening.enunciado.as_ref().unwrap()));
        let mut simulation = ctx(true);
        simulation.en_tamizaje = false;
        assert!(simulation
            .reglas()
            .contains("This is a simulation: no help"));
        assert!(!simulation.reglas().contains("may leave screening"));
        assert!(ctx(false).reglas().contains("the system supplies the hint"));
        let mut rest = ctx(false);
        rest.hay_pistas = false;
        rest.en_pausa = true;
        rest.pausa_restante_s = Some(90);
        assert!(rest
            .reglas()
            .contains("active break (1 min 30 s remaining)"));
        assert!(rest.reglas().contains("do not discuss exercises"));
        assert!(!rest.reglas().contains("the system supplies the hint"));
        rest.pausa_restante_s = None;
        assert!(rest.reglas().contains("a few minutes remaining"));
        let mut ended = ctx(false);
        ended.hay_pistas = false;
        ended.terminada = true;
        assert!(ended.reglas().contains("The session has ended"));
        assert!(!ended.reglas().contains("The session is not over"));
        assert_eq!(minutos(20), "20 seconds");
        assert_eq!(minutos(60), "1 minute");
        assert_eq!(minutos(120), "2 minutes");
    }

    #[test]
    fn intenciones() {
        assert_eq!(
            clasificar("que significa simplificar?"),
            Intencion::AclararPalabra
        );
        assert_eq!(
            clasificar("no se, que signfica simplificar?"),
            Intencion::AclararPalabra
        );
        assert_eq!(
            clasificar("qué era el denominador"),
            Intencion::AclararPalabra
        );
        assert_eq!(clasificar("dime la respuesta"), Intencion::PedirRespuesta);
        assert_eq!(clasificar("estoy cansado"), Intencion::EstoyCansado);
        assert_eq!(clasificar("3/4"), Intencion::RespuestaAlEjercicio);
        assert_eq!(clasificar("hola aule"), Intencion::Charla);
        assert_eq!(clasificar("que?"), Intencion::Charla);
        assert_eq!(clasificar("me ayudas?"), Intencion::PedirAyuda);
        assert_eq!(clasificar("linea 1 linea 2"), Intencion::Charla);
        assert_eq!(clasificar("es 12"), Intencion::RespuestaAlEjercicio);
        for i in Intencion::TODAS {
            assert_eq!(Intencion::desde_str(i.nombre()), Some(i));
        }
    }

    #[test]
    fn simplificar_con_otro_ejemplo() {
        let r = respuesta_guion(
            Intencion::AclararPalabra,
            "que significa simplificar?",
            &ctx(true),
            0,
            "Liam",
        );
        assert!(r.contains("Simplificar es"));
        assert!(!r.contains("6/8") && !r.contains(" 6") && !r.contains("8 "));
        for v in 0..6 {
            let r = respuesta_guion(
                Intencion::AclararPalabra,
                "que es simplificar",
                &ctx(true),
                v,
                "Liam",
            );
            assert!(
                !r.contains("3/4"),
                "no debe llegar al valor del ejercicio: {r}"
            );
        }
    }

    #[test]
    fn sin_ayuda_en_tamizaje() {
        let r = respuesta_guion(
            Intencion::PedirRespuesta,
            "dime la respuesta",
            &ctx(true),
            0,
            "Liam",
        );
        assert!(r.contains("salir del Tamizaje"));
        assert!(!r.contains("3/4"));
    }

    #[test]
    fn variantes_distintas() {
        let c = ctx(true);
        let a = respuesta_guion(Intencion::Charla, "que?", &c, 0, "Liam");
        let b = respuesta_guion(Intencion::Charla, "que?", &c, 1, "Liam");
        let d = respuesta_guion(Intencion::Charla, "que?", &c, 2, "Liam");
        assert!(a != b && b != d && a != d);
    }
}
