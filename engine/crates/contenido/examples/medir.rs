//! Mide sesiones enteras del motor con alumnos de guion, sin modelo ni red.
//!
//! Cada alumno contesta lo que el motor espera con una conducta fija (acierta,
//! falla, no explica, se cansa, pregunta, pide ayuda) y un reloj que avanza 45 s
//! por turno. Al final dice, por alumno: si la sesión terminó, cuántos turnos y
//! minutos tomó, cuántas palabras dijo Aule por cada turno del alumno, y cuántas
//! líneas no sirven para una sesión por voz (piden escribir o apretar botones,
//! hablan de WhatsApp o de una fecha inventada) o se repiten.
//!
//! ```bash
//! cd engine && cargo run --release -p contenido --example medir
//! cargo run --release -p contenido --example medir -- --lineas   # y las líneas marcadas
//! ```

use aule_core::config::Config;
use aule_core::conversacion::Intencion;
use aule_core::modelo::{EstadoObjetivo, Objetivo, Perfil, TipoObjetivo};
use aule_core::motor::{Calificacion, Entrada, Esperando, Mensaje, Motor};
use aule_core::reloj::RelojManual;
use chrono::NaiveDate;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

const TURNO_S: u64 = 45;
const MAX_TURNOS: usize = 400;

/// Lo que en una sesión por voz no se puede hacer o no se debe decir: pedir
/// que escriba o apriete algo, hablar del informe por WhatsApp. "Se escribe
/// 1/4" enseña cómo se escribe y no cuenta.
const NO_PARA_VOZ: [&str; 14] = [
    "escribe",
    "escríbe",
    "escribes",
    "escríbeme",
    "escríbela",
    "botón",
    "aprieta",
    "apretar",
    "presiona",
    "recuadro",
    "cuadro",
    "whatsapp",
    "8pm",
    "vista previa",
];
const FECHAS: [&str; 8] = [
    "nos vemos el",
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábado",
    "domingo",
];

#[derive(Clone, Copy, PartialEq)]
enum Conducta {
    Acierta,
    FallaUnaDeDos,
    FallaTodo,
    NoExplica,
    SeCansa,
    Pregunta,
    PideAyuda,
}

impl Conducta {
    fn nombre(self) -> &'static str {
        match self {
            Conducta::Acierta => "acierta",
            Conducta::FallaUnaDeDos => "falla una de dos",
            Conducta::FallaTodo => "falla todo",
            Conducta::NoExplica => "no explica",
            Conducta::SeCansa => "se cansa",
            Conducta::Pregunta => "pregunta",
            Conducta::PideAyuda => "pide ayuda",
        }
    }
}

fn hoy() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 11, 20).unwrap()
}

fn objetivo(con_fecha: bool, tarea: Option<String>) -> Objetivo {
    Objetivo {
        id: 1,
        tipo: TipoObjetivo::Tarea,
        curso: "Matemáticas".into(),
        tema: "Fracciones".into(),
        fecha: con_fecha.then(|| hoy() + chrono::Duration::days(5)),
        sin_fecha_confirmado: !con_fecha,
        nivel_objetivo: None,
        tarea_id: tarea,
        evaluacion_id: None,
        falladas: vec![],
        estado: EstadoObjetivo::Pendiente,
    }
}

/// Como la plataforma: una hora de sesión.
fn config() -> Config {
    let mut c = Config::default();
    c.sesion_maxima_min = 60;
    c.sesion_recomendada_min = c.sesion_recomendada_min.min(60);
    c
}

#[derive(Default)]
struct Medida {
    terminada: bool,
    turnos: usize,
    minutos: f64,
    lineas: usize,
    palabras: usize,
    mas_larga: usize,
    no_para_voz: Vec<String>,
    fechas: Vec<String>,
    repetidas_seguidas: usize,
    repetidas_3_o_mas: BTreeSet<String>,
    turnos_sin_respuesta: usize,
}

fn palabras(t: &str) -> usize {
    t.split_whitespace().count()
}

fn sesion(conducta: Conducta, con_fecha: bool) -> Medida {
    let banco = Arc::new(contenido::cargar_validado().expect("banco válido"));
    let reloj = RelojManual::new();
    let perfil = Perfil::nuevo("Liam", "fútbol", "Ana", hoy());
    let tarea = banco.tareas.first().map(|t| t.id.clone());
    let mut motor = Motor::new(
        config(),
        banco,
        Arc::new(reloj.clone()),
        perfil,
        vec![objetivo(con_fecha, tarea)],
    );
    let mut dichas: Vec<String> = vec![];
    let mut m = Medida::default();
    let oir = |ms: Vec<Mensaje>, m: &mut Medida, dichas: &mut Vec<String>| -> usize {
        for msj in &ms {
            let t = msj.texto.trim().to_string();
            if t.is_empty() {
                continue;
            }
            let bajo = t.to_lowercase();
            let sin_ensenar = bajo.replace("se escribe", "");
            if NO_PARA_VOZ.iter().any(|p| sin_ensenar.contains(p)) {
                m.no_para_voz.push(t.clone());
            }
            if FECHAS.iter().any(|p| bajo.contains(p)) {
                m.fechas.push(t.clone());
            }
            if dichas.last() == Some(&t) {
                m.repetidas_seguidas += 1;
            }
            m.lineas += 1;
            m.palabras += palabras(&t);
            m.mas_larga = m.mas_larga.max(palabras(&t));
            if std::env::var("VER").is_ok_and(|v| v == conducta.nombre()) {
                println!("  AULE: {t}");
            }
            dichas.push(t);
        }
        ms.len()
    };
    let abiertas = motor.entrada(Entrada::Comenzar);
    oir(abiertas, &mut m, &mut dichas);
    let mut contestadas = 0usize;
    let mut cansado = false;
    while !motor.terminada() && m.turnos < MAX_TURNOS {
        reloj.avanzar_s(TURNO_S);
        m.turnos += 1;
        let antes = motor.actividad();
        // Como la plataforma: el tiempo que pasó actúa antes de lo que se dice.
        let mut dichos = oir(motor.entrada(Entrada::Tick), &mut m, &mut dichas);
        if conducta == Conducta::SeCansa && !cansado && motor.transcurrido_min() > 5.0 {
            cansado = true;
            dichos += oir(
                motor.entrada(Entrada::Texto("Estoy muy cansado, ya no puedo más.".into())),
                &mut m,
                &mut dichas,
            );
            dichos += oir(motor.entrada(Entrada::Cansado), &mut m, &mut dichas);
        }
        let entrada = match motor.esperando() {
            Esperando::Respuesta {
                pide_explicacion, ..
            } => {
                contestadas += 1;
                if conducta == Conducta::Pregunta && contestadas.is_multiple_of(3) {
                    dichos += oir(
                        motor.entrada(Entrada::Chat {
                            texto: "¿Qué es un denominador?".into(),
                            intencion: Intencion::AclararPalabra,
                        }),
                        &mut m,
                        &mut dichas,
                    );
                }
                if conducta == Conducta::PideAyuda && contestadas.is_multiple_of(2) {
                    dichos += oir(motor.entrada(Entrada::Ayuda), &mut m, &mut dichas);
                }
                let bien = match conducta {
                    Conducta::FallaTodo => false,
                    Conducta::FallaUnaDeDos => contestadas.is_multiple_of(2),
                    _ => true,
                };
                let explica = conducta != Conducta::NoExplica;
                Entrada::Calificada(Calificacion {
                    respuesta_correcta: bien,
                    explicacion_correcta: pide_explicacion.then_some(bien && explica),
                    ..Default::default()
                })
            }
            Esperando::Explicacion { .. } => Entrada::Calificada(Calificacion {
                respuesta_correcta: true,
                explicacion_correcta: Some(
                    conducta != Conducta::NoExplica && conducta != Conducta::FallaTodo,
                ),
                ..Default::default()
            }),
            Esperando::Conversacion { sugerencias } => {
                Entrada::Texto(sugerencias.first().cloned().unwrap_or_else(|| "Sí".into()))
            }
            Esperando::Actividad { .. } => {
                let e = Entrada::Actividad(0);
                dichos += oir(motor.entrada(e), &mut m, &mut dichas);
                // Hace la actividad y vuelve.
                reloj.avanzar_s(4 * 60);
                Entrada::Texto("Ya volví.".into())
            }
            // Ninguno lee fotos: sin el ajuste `foto_tarea` no se pide la Tarea.
            Esperando::FotoTarea => Entrada::Texto("No tengo.".into()),
            Esperando::Nada => Entrada::Tick,
        };
        if std::env::var("VER").is_ok_and(|v| v == conducta.nombre()) {
            println!(
                "[{:>4.1} min] ALUMNO ({}): {:?}",
                motor.transcurrido_min(),
                motor.actividad(),
                entrada
            );
        }
        dichos += oir(motor.entrada(entrada), &mut m, &mut dichas);
        if dichos == 0 && motor.actividad() == antes {
            m.turnos_sin_respuesta += 1;
        }
    }
    let mut cuenta: BTreeMap<&String, usize> = BTreeMap::new();
    for d in &dichas {
        *cuenta.entry(d).or_default() += 1;
    }
    m.repetidas_3_o_mas = cuenta
        .into_iter()
        .filter(|(_, n)| *n >= 3)
        .map(|(t, _)| t.clone())
        .collect();
    m.terminada = motor.terminada();
    m.minutos = motor.transcurrido_min();
    m
}

fn main() {
    let ver_lineas = std::env::args().any(|a| a == "--lineas");
    let conductas = [
        Conducta::Acierta,
        Conducta::FallaUnaDeDos,
        Conducta::FallaTodo,
        Conducta::NoExplica,
        Conducta::SeCansa,
        Conducta::Pregunta,
        Conducta::PideAyuda,
    ];
    println!(
        "{:<18} {:<5} {:>4} {:>6} {:>6} {:>7} {:>6} {:>8} {:>6} {:>7} {:>7} {:>7}",
        "alumno",
        "fecha",
        "fin",
        "turnos",
        "min",
        "líneas",
        "pal/t",
        "más larga",
        "voz",
        "fechas",
        "repite",
        "mudo"
    );
    let mut total = Medida::default();
    let mut marcadas: BTreeSet<String> = BTreeSet::new();
    for conducta in conductas {
        for con_fecha in [true, false] {
            let m = sesion(conducta, con_fecha);
            println!(
                "{:<18} {:<5} {:>4} {:>6} {:>6.1} {:>7} {:>6.1} {:>8} {:>6} {:>7} {:>7} {:>7}",
                conducta.nombre(),
                if con_fecha { "sí" } else { "no" },
                if m.terminada { "sí" } else { "NO" },
                m.turnos,
                m.minutos,
                m.lineas,
                m.palabras as f64 / m.turnos.max(1) as f64,
                m.mas_larga,
                m.no_para_voz.len(),
                m.fechas.len(),
                m.repetidas_seguidas + m.repetidas_3_o_mas.len(),
                m.turnos_sin_respuesta,
            );
            marcadas.extend(m.no_para_voz.iter().map(|t| format!("[voz] {t}")));
            marcadas.extend(m.fechas.iter().map(|t| format!("[fecha] {t}")));
            marcadas.extend(
                m.repetidas_3_o_mas
                    .iter()
                    .map(|t| format!("[3+ veces] {t}")),
            );
            total.turnos += m.turnos;
            total.palabras += m.palabras;
            total.no_para_voz.extend(m.no_para_voz);
            total.fechas.extend(m.fechas);
            total.repetidas_seguidas += m.repetidas_seguidas;
            total.turnos_sin_respuesta += m.turnos_sin_respuesta;
            total.terminada |= !m.terminada;
        }
    }
    println!(
        "\nTOTAL  palabras de Aule por turno del alumno {:.1} | líneas no aptas para voz {} | con fecha {} | repetidas seguidas {} | turnos sin respuesta {} | alguna sin terminar: {}",
        total.palabras as f64 / total.turnos.max(1) as f64,
        total.no_para_voz.len(),
        total.fechas.len(),
        total.repetidas_seguidas,
        total.turnos_sin_respuesta,
        if total.terminada { "sí" } else { "no" },
    );
    if ver_lineas {
        println!("\nLíneas marcadas (distintas):");
        for t in marcadas {
            println!("  {t}");
        }
    }
}
