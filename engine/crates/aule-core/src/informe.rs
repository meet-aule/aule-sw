//! DEMO-09 / INF-02: vista previa del informe al Padre de familia (WhatsApp, 8pm).
//! Un solo saludo y luego un mensaje por cada cosa que se hizo.
//! Las plantillas van tal cual; solo cambian los corchetes.

use crate::modelo::fecha_larga;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum Hecho {
    Tamizaje {
        curso: String,
        temas_mejora: Vec<String>,
        tema: String,
        sesiones: u32,
        comienzo: String,
    },
    /// [PROPUESTA] el tamizaje no encontró oportunidad de mejora (ya tiene el nivel).
    TamizajeSinMejora {
        curso: String,
        tema: String,
        nivel: u8,
    },
    TamizajeIncompleto {
        curso: String,
        tema: String,
        proxima: NaiveDate,
    },
    Tarea {
        curso: String,
        temas: Vec<String>,
        fecha: Option<NaiveDate>,
        subtemas: Vec<String>,
    },
    Preparacion {
        curso: String,
        temas: Vec<String>,
        fecha: Option<NaiveDate>,
        subtemas: Vec<String>,
    },
    Correccion {
        curso: String,
        fecha: Option<NaiveDate>,
        temas: Vec<String>,
    },
    Extracurricular {
        curso: String,
        temas: Vec<String>,
        /// Vino después de terminar otro objetivo antes de 30 minutos (OBJ-11 / SES-02).
        #[serde(default)]
        tras_objetivo: bool,
    },
    ObjetivoContinua {
        curso: String,
        temas: Vec<String>,
        es_tarea: bool,
        fecha: Option<NaiveDate>,
        dominados: Vec<String>,
        faltan: Vec<String>,
        proxima: NaiveDate,
    },
    SimulacionConErrores {
        curso: String,
        fecha: Option<NaiveDate>,
        bien: Vec<String>,
        mal: Vec<String>,
    },
    /// [PROPUESTA] OBJ-08: curso o tema que no cubrimos.
    NoCubierto {
        curso: String,
        tema: String,
        que: String,
    },
    /// [PROPUESTA] El Alumno pidió un tema que todavía no tenemos.
    TemaPedido { tema: String },
    /// [PROPUESTA] TAR-05: se vio la Tarea en una foto; su nivel fue el Nivel objetivo.
    TareaVista { curso: String, subtema: String },
    /// [PROPUESTA] TAR-07: la Tarea de la foto no es del tema que enseñamos (OBJ-08).
    TareaOtroTema { tema: String },
    /// [PROPUESTA] TAR-08: la Tarea del banco no tenía ejercicios hasta el nivel
    /// de la foto; el Alumno ya domina lo que pide su Tarea.
    TareaPreparada {
        curso: String,
        fecha: Option<NaiveDate>,
        subtema: String,
    },
}

/// "a, b y c"
pub fn lista(v: &[String]) -> String {
    unir(v, "y")
}

/// "a, b o c": para ofrecer entre varias.
pub fn lista_o(v: &[String]) -> String {
    unir(v, "o")
}

fn unir(v: &[String], conjuncion: &str) -> String {
    match v.len() {
        0 => String::new(),
        1 => v[0].clone(),
        _ => format!(
            "{} {conjuncion} {}",
            v[..v.len() - 1].join(", "),
            v[v.len() - 1]
        ),
    }
}

fn f(o: &Option<NaiveDate>) -> String {
    o.map(fecha_larga).unwrap_or_else(|| "próximo".into())
}

/// Devuelve los mensajes: el primero es siempre el saludo.
pub fn generar(nombre_padre: &str, nombre_alumno: &str, hechos: &[Hecho]) -> Vec<String> {
    let mut m = vec![format!(
        "¡Hola, {nombre_padre}! Te saluda Aule, tutor de {nombre_alumno}."
    )];
    for h in hechos {
        match h {
            Hecho::Tamizaje {
                curso,
                temas_mejora,
                tema,
                sesiones,
                comienzo,
            } => {
                m.push(format!(
                    "El día de hoy hemos evaluado cómo le va en {curso}, y hemos encontrado una oportunidad de mejora específicamente en {}.",
                    lista(temas_mejora)
                ));
                // Única licencia sobre la plantilla: concordancia de número ("1 sesión").
                let ses = if *sesiones == 1 { "sesión" } else { "sesiones" };
                m.push(format!(
                    "El plan que proponemos consiste de {sesiones} {ses} para {tema} y comenzamos {comienzo}."
                ));
            }
            Hecho::TamizajeSinMejora { curso, tema, nivel } => m.push(format!(
                "El día de hoy hemos evaluado cómo le va en {curso} con el tema de {tema}, y {nombre_alumno} ya resuelve el nivel {nivel} de 5. ¡Felicidades!"
            )),
            Hecho::TamizajeIncompleto {
                curso,
                tema,
                proxima,
            } => {
                m.push(format!(
                    "El día de hoy hemos empezado a evaluar cómo le va en {curso} con el tema de {tema}."
                ));
                m.push(format!(
                    "No llegamos a terminar, así que lo retomamos en nuestra próxima sesión, el día {}, y ahí te cuento el plan que proponemos.",
                    fecha_larga(*proxima)
                ));
            }
            Hecho::Tarea {
                curso,
                temas,
                fecha,
                subtemas,
            } => {
                m.push(format!(
                    "El día de hoy hemos hecho la tarea de {curso} sobre el tema de {} para el día {}.",
                    lista(temas),
                    f(fecha)
                ));
                m.push(format!(
                    "Ahora {nombre_alumno} domina {}. ¡Felicidades!",
                    lista(subtemas)
                ));
            }
            Hecho::Preparacion {
                curso,
                temas,
                fecha,
                subtemas,
            } => {
                m.push(format!(
                    "El día de hoy nos hemos preparado para la evaluación de {curso} sobre el tema de {} para el día {}.",
                    lista(temas),
                    f(fecha)
                ));
                m.push(format!(
                    "Ahora {nombre_alumno} domina {} y ya está listo para la evaluación. ¡Felicidades!",
                    lista(subtemas)
                ));
            }
            Hecho::Correccion { curso, fecha, temas } => {
                m.push(format!(
                    "El día de hoy hemos revisado la evaluación de {curso} del día {}, y hemos trabajado los temas donde tuvo errores: {}.",
                    f(fecha),
                    lista(temas)
                ));
                m.push(format!(
                    "Ahora {nombre_alumno} ya resuelve por su cuenta las preguntas que antes falló. Los errores son parte normal de aprender, y nuestro objetivo es que en cada evaluación sean menos. ¡Felicidades!"
                ));
            }
            Hecho::Extracurricular {
                curso,
                temas,
                tras_objetivo,
            } => {
                if *tras_objetivo {
                    // [PROPUESTA] variante: el extracurricular vino tras terminar antes de tiempo.
                    m.push(format!(
                        "Como terminamos antes de tiempo, el día de hoy también hemos practicado el tema de {} para el curso de {curso}.",
                        lista(temas)
                    ));
                } else {
                    m.push(format!(
                        "Como no hemos encontrado ni tareas ni evaluaciones venideras, el día de hoy hemos practicado el tema de {} para el curso de {curso}.",
                        lista(temas)
                    ));
                }
                m.push(
                    "En caso te gustaría aprender algo en específico en nuestra próxima sesión, ¡házmelo saber!"
                        .to_string(),
                );
            }
            Hecho::ObjetivoContinua {
                curso,
                temas,
                es_tarea,
                fecha,
                dominados,
                faltan,
                proxima,
            } => {
                m.push(format!(
                    "El día de hoy hemos avanzado en {curso} con el tema de {}, para {} del día {}.",
                    lista(temas),
                    if *es_tarea { "la tarea" } else { "la evaluación" },
                    f(fecha)
                ));
                let dom = if dominados.is_empty() {
                    "las bases del tema".to_string()
                } else {
                    lista(dominados)
                };
                m.push(format!(
                    "{nombre_alumno} ya domina {dom} y nos falta {}. Lo retomamos en nuestra próxima sesión, el día {}.",
                    lista(faltan),
                    fecha_larga(*proxima)
                ));
            }
            Hecho::SimulacionConErrores {
                curso,
                fecha,
                bien,
                mal,
            } => {
                m.push(format!(
                    "El día de hoy hemos simulado la evaluación de {curso} del día {}.",
                    f(fecha)
                ));
                let b = if bien.is_empty() {
                    "algunas preguntas".to_string()
                } else {
                    lista(bien)
                };
                m.push(format!(
                    "A {nombre_alumno} le fue bien en {b} y tuvo errores en {}. Es normal, y qué bueno que lo vimos ahora y no en la evaluación. Trabajamos esos temas y te cuento cómo nos fue.",
                    lista(mal)
                ));
            }
            Hecho::NoCubierto { curso, tema, que } => m.push(format!(
                "{nombre_alumno} nos contó que tiene {que} de {curso} sobre {tema}. Todavía no cubrimos ese tema, así que no lo trabajamos hoy; te recomendamos revisarlo con su Docente."
            )),
            Hecho::TemaPedido { tema } => m.push(format!(
                "{nombre_alumno} nos dijo que le gustaría aprender sobre {tema}. Todavía no lo tenemos, pero lo anotamos."
            )),
            Hecho::TareaVista { curso, subtema } => m.push(format!(
                "{nombre_alumno} nos mostró su tarea de {curso}: es sobre {subtema}."
            )),
            Hecho::TareaOtroTema { tema } => m.push(format!(
                "{nombre_alumno} nos mostró una tarea que no es del tema de {tema}. Todavía no cubrimos ese tema, así que no la trabajamos hoy; te recomendamos revisarla con su Docente."
            )),
            Hecho::TareaPreparada {
                curso,
                fecha,
                subtema,
            } => m.push(format!(
                "{nombre_alumno} ya domina lo que pide su tarea de {curso} para el día {}: {subtema}. Ya la puede hacer por su cuenta. ¡Felicidades!",
                f(fecha)
            )),
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    /// D3: un solo saludo.
    #[test]
    fn d3_un_solo_saludo() {
        let h = vec![
            Hecho::TamizajeSinMejora {
                curso: "Matemáticas".into(),
                tema: "Fracciones".into(),
                nivel: 3,
            },
            Hecho::Tarea {
                curso: "Matemáticas".into(),
                temas: vec!["Fracciones".into()],
                fecha: None,
                subtemas: vec!["sumar".into()],
            },
            Hecho::Extracurricular {
                curso: "Matemáticas".into(),
                temas: vec!["Fracciones".into()],
                tras_objetivo: false,
            },
        ];
        let m = generar("Ana", "Liam", &h);
        assert_eq!(m.iter().filter(|x| x.contains("¡Hola")).count(), 1);
        assert!(m[0].starts_with("¡Hola, Ana! Te saluda Aule, tutor de Liam."));
        assert_eq!(m.len(), 1 + 1 + 2 + 2);
    }
}
