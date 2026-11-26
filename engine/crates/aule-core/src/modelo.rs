//! Objetivos de la sesión, perfil del alumno (lo que se conserva entre
//! sesiones) y utilidades de fechas en español.

use crate::texto::normalizar;
use chrono::{Datelike, Duration, NaiveDate, Weekday};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// OBJ-05: los 4 tipos de objetivo. El orden de declaración es el desempate de OBJ-09.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum TipoObjetivo {
    Preparacion,
    Tarea,
    Correccion,
    Extracurricular,
}

impl TipoObjetivo {
    pub fn nombre(&self) -> &'static str {
        match self {
            TipoObjetivo::Preparacion => "Preparación para evaluación",
            TipoObjetivo::Tarea => "Tarea",
            TipoObjetivo::Correccion => "Corrección de evaluación",
            TipoObjetivo::Extracurricular => "Aprendizaje extracurricular",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EstadoObjetivo {
    Pendiente,
    EnCurso,
    Completado,
    /// OBJ-08: curso o tema que no cubrimos.
    NoCubierto,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Objetivo {
    pub id: u32,
    pub tipo: TipoObjetivo,
    pub curso: String,
    pub tema: String,
    pub fecha: Option<NaiveDate>,
    /// OBJ-10: ya dijeron que no hay fecha.
    #[serde(default)]
    pub sin_fecha_confirmado: bool,
    /// OBJ-06 / DEMO-02 [PROPUESTA]: lo carga quien presenta.
    pub nivel_objetivo: Option<u8>,
    /// Tarea del banco (si es Tarea).
    #[serde(default)]
    pub tarea_id: Option<String>,
    /// Evaluación del banco (si es Corrección).
    #[serde(default)]
    pub evaluacion_id: Option<String>,
    /// Corrección: índices de las preguntas falladas.
    #[serde(default)]
    pub falladas: Vec<usize>,
    pub estado: EstadoObjetivo,
}

impl Objetivo {
    pub fn cubierto_por(&self, curso: &str, tema: &str) -> bool {
        normalizar(&self.curso) == normalizar(curso) && normalizar(&self.tema) == normalizar(tema)
    }
}

/// OBJ-09: primero la fecha más cercana; si coinciden, por tipo.
/// Los que no tienen fecha van al final (siguen ordenados por tipo).
pub fn ordenar_objetivos(objs: &mut [Objetivo]) {
    objs.sort_by(|a, b| {
        let fa = a.fecha.unwrap_or(NaiveDate::MAX);
        let fb = b.fecha.unwrap_or(NaiveDate::MAX);
        fa.cmp(&fb).then(a.tipo.cmp(&b.tipo)).then(a.id.cmp(&b.id))
    });
}

/// TAM-06: tamizaje que quedó a medias, para retomarlo.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TamizajeParcial {
    /// Resultados por nivel (nivel, correcta).
    pub respuestas: Vec<(u8, bool)>,
    /// Nivel en el que se retoma (con otra pregunta).
    pub retomar_en: u8,
    /// Preguntas ya usadas (para no repetir).
    pub usadas: BTreeSet<String>,
}

/// Lo que se conserva entre sesiones (DEMO-15).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Perfil {
    pub nombre_alumno: String,
    pub intereses: String,
    pub nombre_padre: String,
    /// NIV-01: nivel por tema (0 = "ningún nivel"). Ausente = todavía no lo conocemos.
    pub niveles: BTreeMap<String, u8>,
    pub tamizaje_parcial: BTreeMap<String, TamizajeParcial>,
    /// MET-04: minutos que tomó dominar cada nivel (historial).
    pub time_to_master: Vec<(String, u8, f64)>,
    /// Ejercicios de Etapa 2 ya usados (para variar entre sesiones).
    pub ejercicios_usados: BTreeSet<String>,
    /// OBJ-11: sugerencia del padre de familia antes de la sesión.
    pub sugerencia_padre: Option<String>,
    pub hoy: NaiveDate,
    pub proxima_sesion: NaiveDate,
    pub numero_sesion: u32,
    /// Temas que el alumno pidió y no cubrimos (para el informe).
    pub temas_pedidos: Vec<String>,
    /// [PROPUESTA] Minuto del día (0 a 1439) en que empezó la sesión, en la hora
    /// de la familia. Ausente = no se sabe (PAU-07 no se aplica).
    #[serde(default)]
    pub minuto_inicio: Option<u16>,
}

impl Perfil {
    pub fn nuevo(nombre: &str, intereses: &str, padre: &str, hoy: NaiveDate) -> Self {
        Perfil {
            nombre_alumno: nombre.into(),
            intereses: intereses.into(),
            nombre_padre: padre.into(),
            niveles: BTreeMap::new(),
            tamizaje_parcial: BTreeMap::new(),
            time_to_master: vec![],
            ejercicios_usados: BTreeSet::new(),
            sugerencia_padre: None,
            hoy,
            proxima_sesion: hoy + Duration::days(2),
            numero_sesion: 1,
            temas_pedidos: vec![],
            minuto_inicio: None,
        }
    }
}

const DIAS: [&str; 7] = [
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábado",
    "domingo",
];
const MESES: [&str; 12] = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
];

/// "jueves 19 de noviembre"
pub fn fecha_larga(f: NaiveDate) -> String {
    format!(
        "{} {} de {}",
        DIAS[f.weekday().num_days_from_monday() as usize],
        f.day(),
        MESES[f.month0() as usize]
    )
}

#[derive(Debug, PartialEq)]
pub enum FechaDicha {
    Fecha(NaiveDate),
    NoHay,
    NoSe,
}

/// OBJ-10: interpreta una fecha dicha por el alumno, relativa a `hoy`.
pub fn leer_fecha(texto: &str, hoy: NaiveDate) -> FechaDicha {
    let t = normalizar(texto);
    if t.contains("no hay")
        || t.contains("no tiene")
        || t.contains("sin fecha")
        || t.contains("ninguna")
        || t == "no"
    {
        return FechaDicha::NoHay;
    }
    if t.contains("pasado manana") {
        return FechaDicha::Fecha(hoy + Duration::days(2));
    }
    if t.contains("manana") {
        return FechaDicha::Fecha(hoy + Duration::days(1));
    }
    if t.split_whitespace().any(|w| w == "hoy") {
        return FechaDicha::Fecha(hoy);
    }
    // "15/11" o "15-11"
    for w in t.split_whitespace() {
        if let Some((d, m)) = w.split_once('/') {
            if let (Ok(d), Ok(m)) = (
                d.parse::<u32>(),
                m.split('/').next().unwrap_or("").parse::<u32>(),
            ) {
                if let Some(f) = proxima_fecha(hoy, m, d) {
                    return FechaDicha::Fecha(f);
                }
            }
        }
    }
    // "15 de noviembre"
    let toks: Vec<&str> = t.split_whitespace().collect();
    for (i, w) in toks.iter().enumerate() {
        if let Some(m) = MESES.iter().position(|x| normalizar(x) == *w) {
            let d = toks[..i]
                .iter()
                .rev()
                .find_map(|x| x.parse::<u32>().ok().or_else(|| numero_palabra(x)));
            if let Some(d) = d {
                if let Some(f) = proxima_fecha(hoy, m as u32 + 1, d) {
                    return FechaDicha::Fecha(f);
                }
            }
        }
    }
    // Día de la semana: el próximo (si es hoy, la semana que viene salvo "este").
    let dias = [
        ("lunes", Weekday::Mon),
        ("martes", Weekday::Tue),
        ("miercoles", Weekday::Wed),
        ("jueves", Weekday::Thu),
        ("viernes", Weekday::Fri),
        ("sabado", Weekday::Sat),
        ("domingo", Weekday::Sun),
    ];
    for (n, wd) in dias {
        if toks.contains(&n) {
            let mut f = hoy + Duration::days(1);
            while f.weekday() != wd {
                f += Duration::days(1);
            }
            if t.contains("proxima semana") || t.contains("siguiente semana") {
                f += Duration::days(7);
            }
            return FechaDicha::Fecha(f);
        }
    }
    // "el 20" (día del mes)
    if let Some(d) = toks
        .iter()
        .find_map(|x| x.parse::<u32>().ok())
        .filter(|d| (1..=31).contains(d))
    {
        let mut m = hoy.month();
        for _ in 0..2 {
            if let Some(f) = NaiveDate::from_ymd_opt(hoy.year(), m, d).filter(|f| *f >= hoy) {
                return FechaDicha::Fecha(f);
            }
            m = m % 12 + 1;
        }
    }
    FechaDicha::NoSe
}

fn numero_palabra(w: &str) -> Option<u32> {
    let toks = [w];
    crate::texto::leer_fraccion(toks[0])
        .filter(|f| f.den == 1 && f.entero.is_none())
        .map(|f| f.num as u32)
}

fn proxima_fecha(hoy: NaiveDate, mes: u32, dia: u32) -> Option<NaiveDate> {
    let f = NaiveDate::from_ymd_opt(hoy.year(), mes, dia)?;
    if f >= hoy {
        Some(f)
    } else {
        NaiveDate::from_ymd_opt(hoy.year() + 1, mes, dia)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, dd: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, dd).unwrap()
    }

    #[test]
    fn fechas() {
        let hoy = d(2026, 11, 14); // sábado
        assert_eq!(
            leer_fecha("mañana", hoy),
            FechaDicha::Fecha(d(2026, 11, 15))
        );
        assert_eq!(
            leer_fecha("el jueves", hoy),
            FechaDicha::Fecha(d(2026, 11, 19))
        );
        assert_eq!(
            leer_fecha("20 de noviembre", hoy),
            FechaDicha::Fecha(d(2026, 11, 20))
        );
        assert_eq!(
            leer_fecha("el 3/12", hoy),
            FechaDicha::Fecha(d(2026, 12, 3))
        );
        assert_eq!(leer_fecha("No hay fecha", hoy), FechaDicha::NoHay);
        assert_eq!(leer_fecha("no sé", hoy), FechaDicha::NoSe);
        assert_eq!(fecha_larga(d(2026, 11, 19)), "jueves 19 de noviembre");
    }

    fn obj(id: u32, tipo: TipoObjetivo, f: Option<NaiveDate>) -> Objetivo {
        Objetivo {
            id,
            tipo,
            curso: "Matemáticas".into(),
            tema: "Fracciones".into(),
            fecha: f,
            sin_fecha_confirmado: false,
            nivel_objetivo: Some(3),
            tarea_id: None,
            evaluacion_id: None,
            falladas: vec![],
            estado: EstadoObjetivo::Pendiente,
        }
    }

    /// A5: tarea el jueves y evaluación el viernes: primero la tarea.
    #[test]
    fn a5_primero_la_fecha_mas_cercana() {
        let mut v = vec![
            obj(1, TipoObjetivo::Preparacion, Some(d(2026, 11, 20))),
            obj(2, TipoObjetivo::Tarea, Some(d(2026, 11, 19))),
        ];
        ordenar_objetivos(&mut v);
        assert_eq!(v[0].tipo, TipoObjetivo::Tarea);
    }

    /// A6: misma fecha: primero Preparación.
    #[test]
    fn a6_misma_fecha_primero_preparacion() {
        let f = Some(d(2026, 11, 19));
        let mut v = vec![
            obj(1, TipoObjetivo::Correccion, f),
            obj(2, TipoObjetivo::Tarea, f),
            obj(3, TipoObjetivo::Preparacion, f),
        ];
        ordenar_objetivos(&mut v);
        assert_eq!(v[0].tipo, TipoObjetivo::Preparacion);
        assert_eq!(v[1].tipo, TipoObjetivo::Tarea);
        assert_eq!(v[2].tipo, TipoObjetivo::Correccion);
    }
}
