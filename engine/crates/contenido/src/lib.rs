//! Banco de contenido de Fracciones (Matemáticas, 5to de primaria, Perú).
//! Los datos están en `data/*.toml`, embebidos en el binario y validados al
//! arrancar y por tests. Todo el contenido es [PROPUESTA] (ver docs/PENDIENTES.md).

pub mod graficos;

use aule_core::banco::{
    Angulo, Banco, Ejercicio, Evaluacion, Grafico, Interes, NivelContenido, Tarea,
};
use aule_core::correccion::cumple_forma;
use aule_core::expr::{evaluar, Valor};
use aule_core::fraccion::{Fraccion, FraccionEscrita};
use aule_core::texto::normalizar;
use serde::Deserialize;
use std::collections::{BTreeSet, HashSet};

const NIVELES: [&str; 5] = [
    include_str!("../data/nivel1.toml"),
    include_str!("../data/nivel2.toml"),
    include_str!("../data/nivel3.toml"),
    include_str!("../data/nivel4.toml"),
    include_str!("../data/nivel5.toml"),
];
const EXTRAS: &str = include_str!("../data/extras.toml");

pub const INTERESES_OBLIGATORIOS: [&str; 5] =
    ["futbol", "videojuegos", "dinosaurios", "cocina", "musica"];

#[derive(Deserialize)]
struct Extras {
    curso: String,
    tema: String,
    grado: String,
    tareas: Vec<Tarea>,
    evaluaciones: Vec<Evaluacion>,
    intereses: Vec<Interes>,
}

/// Carga el banco embebido. Error si no parsea; la validación es aparte.
pub fn cargar() -> Result<Banco, String> {
    let mut niveles = vec![];
    for (i, t) in NIVELES.iter().enumerate() {
        let mut n: NivelContenido =
            toml::from_str(t).map_err(|e| format!("nivel{}.toml: {e}", i + 1))?;
        let nv = n.nivel;
        for e in n
            .tamizaje
            .iter_mut()
            .chain(n.ejercicios.iter_mut())
            .chain(n.simulacion.iter_mut())
        {
            if e.nivel == 0 {
                e.nivel = nv;
            }
        }
        for e in n.tamizaje.iter_mut() {
            e.pide_explicacion = true;
        }
        niveles.push(n);
    }
    let x: Extras = toml::from_str(EXTRAS).map_err(|e| format!("extras.toml: {e}"))?;
    Ok(Banco {
        curso: x.curso,
        tema: x.tema,
        grado: x.grado,
        niveles,
        tareas: x.tareas,
        evaluaciones: x.evaluaciones,
        intereses: x.intereses,
    })
}

/// Carga y valida; si hay errores los devuelve todos.
pub fn cargar_validado() -> Result<Banco, Vec<String>> {
    let b = cargar().map_err(|e| vec![e])?;
    let errores = validar(&b);
    if errores.is_empty() {
        Ok(b)
    } else {
        Err(errores)
    }
}

fn numeros_en(s: &str) -> BTreeSet<String> {
    let mut v = BTreeSet::new();
    let mut cur = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            cur.push(c);
        } else if !cur.is_empty() {
            v.insert(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        v.insert(cur);
    }
    v
}

/// Comprueba `respuesta` contra `verificar` (y contra las opciones).
pub fn verificar_respuesta(
    respuesta: &str,
    opciones: &[String],
    verificar: &str,
) -> Result<(), String> {
    let v = evaluar(verificar).map_err(|e| format!("verificar '{verificar}': {e}"))?;
    if opciones.is_empty() {
        let r: Fraccion = respuesta
            .parse()
            .map_err(|e| format!("respuesta '{respuesta}' no es fracción: {e}"))?;
        match v {
            Valor::Num(x) if x == r => Ok(()),
            Valor::Num(x) => Err(format!(
                "respuesta '{respuesta}' no coincide con verificar '{verificar}' = {x}"
            )),
            Valor::Bool(_) => Err(format!(
                "respuesta numérica pero verificar es comparación: '{verificar}'"
            )),
        }
    } else {
        if !opciones
            .iter()
            .any(|o| normalizar(o) == normalizar(respuesta))
        {
            return Err(format!("respuesta '{respuesta}' no está en opciones"));
        }
        let Valor::Bool(b) = v else {
            return Err(format!(
                "con opciones, verificar debe ser comparación: '{verificar}'"
            ));
        };
        let r = normalizar(respuesta);
        if r == "falso" {
            if b {
                return Err(format!("respuesta Falso pero '{verificar}' es verdadero"));
            }
        } else if !b {
            return Err(format!(
                "'{verificar}' es falso para la respuesta '{respuesta}'"
            ));
        }
        if ["<", ">", "="].contains(&respuesta.trim()) {
            let op = respuesta.trim();
            let tiene = match op {
                "<" => verificar.contains('<') && !verificar.contains("<="),
                ">" => verificar.contains('>') && !verificar.contains(">="),
                _ => {
                    verificar.contains('=')
                        && !verificar.contains("<=")
                        && !verificar.contains(">=")
                }
            };
            if !tiene {
                return Err(format!(
                    "respuesta '{op}' pero verificar '{verificar}' usa otro símbolo"
                ));
            }
        }
        Ok(())
    }
}

fn val_grafico(g: &Option<Grafico>, donde: &str, err: &mut Vec<String>) {
    if let Some(g) = g {
        for p in graficos::problemas(g) {
            err.push(format!("{donde}: gráfico: {p}"));
        }
    }
}

/// `completo`: exige pistas, pista gráfica y similar (Etapa 2, Tarea, Corrección).
fn val_ejercicio(
    e: &Ejercicio,
    completo: bool,
    intereses: &HashSet<String>,
    err: &mut Vec<String>,
) {
    let d = &e.id;
    if let Err(m) = verificar_respuesta(&e.respuesta, &e.opciones, &e.verificar) {
        err.push(format!("{d}: {m}"));
    }
    if e.opciones.is_empty() {
        match e.respuesta.parse::<FraccionEscrita>() {
            Ok(fe) if !cumple_forma(&fe, e.forma) => err.push(format!(
                "{d}: la respuesta canónica '{}' no cumple la forma {:?}",
                e.respuesta, e.forma
            )),
            Err(m) => err.push(format!("{d}: {m}")),
            _ => {}
        }
    }
    if e.tiempo_s < 20 || e.tiempo_s > 900 {
        err.push(format!("{d}: tiempo_s fuera de rango ({})", e.tiempo_s));
    }
    if e.enunciado.trim().len() < 10 {
        err.push(format!("{d}: enunciado muy corto"));
    }
    if e.nivel == 0 || e.nivel > 5 {
        err.push(format!("{d}: nivel inválido {}", e.nivel));
    }
    val_grafico(&e.grafico, d, err);
    if e.pide_explicacion {
        if e.criterio_explicacion
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
        {
            err.push(format!(
                "{d}: pide explicación pero no tiene criterio_explicacion"
            ));
        }
        if e.claves_explicacion.is_empty() {
            err.push(format!(
                "{d}: pide explicación pero no tiene claves_explicacion"
            ));
        }
    }
    let nums = numeros_en(&e.enunciado);
    for (k, txt) in &e.contextos {
        if !intereses.contains(k) {
            err.push(format!("{d}: contexto con interés desconocido '{k}'"));
        }
        if numeros_en(txt) != nums {
            err.push(format!(
                "{d}: el contexto '{k}' no usa los mismos números ({:?} vs {:?})",
                numeros_en(txt),
                nums
            ));
        }
    }
    if completo {
        if e.pistas.len() != 2 {
            err.push(format!(
                "{d}: debe tener 2 pistas socráticas (tiene {})",
                e.pistas.len()
            ));
        }
        for p in &e.pistas {
            if !p.contains('?') {
                err.push(format!(
                    "{d}: la pista socrática debe ser una pregunta: '{p}'"
                ));
            }
        }
        match &e.pista_grafica {
            None => err.push(format!("{d}: falta pista_grafica")),
            Some(pg) => {
                for p in graficos::problemas(&pg.grafico) {
                    err.push(format!("{d}: pista gráfica: {p}"));
                }
            }
        }
        match &e.similar {
            None => err.push(format!("{d}: falta similar")),
            Some(s) => {
                if normalizar(&s.enunciado) == normalizar(&e.enunciado) {
                    err.push(format!("{d}: el similar es igual al ejercicio"));
                }
                if s.respuesta == e.respuesta && numeros_en(&s.enunciado) == nums {
                    err.push(format!(
                        "{d}: el similar usa los mismos números y respuesta"
                    ));
                }
                if s.pasos.len() < 2 {
                    err.push(format!("{d}: el similar necesita al menos 2 pasos"));
                }
                if let Err(m) = verificar_respuesta(&s.respuesta, &e.opciones, &s.verificar) {
                    err.push(format!("{d} (similar): {m}"));
                }
                val_grafico(&s.grafico, d, err);
            }
        }
    }
}

pub fn validar(b: &Banco) -> Vec<String> {
    let mut err = vec![];
    let intereses: HashSet<String> = b.intereses.iter().map(|i| i.clave.clone()).collect();
    for k in INTERESES_OBLIGATORIOS {
        if !intereses.contains(k) {
            err.push(format!("falta el interés '{k}'"));
        }
    }
    let mut ids = HashSet::new();
    let mut id_unico = |id: &str, err: &mut Vec<String>| {
        if !ids.insert(id.to_string()) {
            err.push(format!("id repetido: {id}"));
        }
    };
    if b.niveles.len() != 5 {
        err.push(format!("debe haber 5 niveles (hay {})", b.niveles.len()));
    }
    for (i, n) in b.niveles.iter().enumerate() {
        let nv = n.nivel;
        let l = format!("nivel {nv}");
        if nv as usize != i + 1 {
            err.push(format!("{l}: está en la posición {}", i + 1));
        }
        // Se dice en una lista con otros niveles: pocas palabras.
        let palabras = n.nombre_corto.split_whitespace().count();
        if palabras == 0 || palabras > 8 {
            err.push(format!(
                "{l}: nombre_corto debe tener entre 1 y 8 palabras (tiene {palabras})"
            ));
        }
        if n.tamizaje.len() < 2 {
            err.push(format!("{l}: necesita 2 preguntas de tamizaje"));
        }
        for e in &n.tamizaje {
            id_unico(&e.id, &mut err);
            val_ejercicio(e, false, &intereses, &mut err);
        }
        if n.ejercicios.len() < 10 {
            err.push(format!("{l}: necesita al menos 10 ejercicios de Etapa 2"));
        }
        for a in Angulo::TODOS {
            let c = n.ejercicios.iter().filter(|e| e.angulo == Some(a)).count();
            if c < 2 {
                err.push(format!(
                    "{l}: el ángulo {a:?} tiene {c} ejercicios (mínimo 2)"
                ));
            }
        }
        for e in &n.ejercicios {
            id_unico(&e.id, &mut err);
            if e.angulo.is_none() {
                err.push(format!("{}: falta angulo", e.id));
            }
            if e.nivel != nv {
                err.push(format!("{}: nivel {} dentro de {l}", e.id, e.nivel));
            }
            val_ejercicio(e, true, &intereses, &mut err);
        }
        if n.simulacion.len() < 4 {
            err.push(format!(
                "{l}: necesita al menos 4 ejercicios de simulación (2 + repuestos)"
            ));
        }
        for e in &n.simulacion {
            id_unico(&e.id, &mut err);
            val_ejercicio(e, false, &intereses, &mut err);
        }
        let e1 = &n.etapa1;
        if e1.teoria.len() < 2 {
            err.push(format!("{l}: la teoría necesita al menos 2 bloques"));
        }
        if e1.no_asistidos.len() < 2 || e1.asistidos.len() < 2 {
            err.push(format!(
                "{l}: Etapa 1 necesita 2 ejemplos no asistidos y 2 asistidos"
            ));
        }
        for (k, x) in e1.no_asistidos.iter().enumerate() {
            if let Err(m) = verificar_respuesta(&x.respuesta, &[], &x.verificar) {
                err.push(format!("{l} no_asistido {k}: {m}"));
            }
            if x.pasos.len() < 2 {
                err.push(format!("{l} no_asistido {k}: al menos 2 pasos"));
            }
            val_grafico(&x.grafico, &l, &mut err);
        }
        for (k, x) in e1.asistidos.iter().enumerate() {
            if let Err(m) = verificar_respuesta(&x.respuesta, &[], &x.verificar) {
                err.push(format!("{l} asistido {k}: {m}"));
            }
            if x.pasos.len() < 2 || x.secuencia.len() < 2 {
                err.push(format!(
                    "{l} asistido {k}: al menos 2 pasos y 2 nombres de secuencia"
                ));
            }
            for (j, p) in x.pasos.iter().enumerate() {
                if p.opciones.is_empty() {
                    if p.respuesta.parse::<Fraccion>().is_err() {
                        err.push(format!(
                            "{l} asistido {k} paso {j}: respuesta '{}' no es fracción ni opción",
                            p.respuesta
                        ));
                    }
                } else if !p
                    .opciones
                    .iter()
                    .any(|o| normalizar(o) == normalizar(&p.respuesta))
                {
                    err.push(format!(
                        "{l} asistido {k} paso {j}: respuesta fuera de opciones"
                    ));
                }
            }
            if let Some(ult) = x.pasos.last() {
                if ult.opciones.is_empty()
                    && ult.respuesta.parse::<Fraccion>().ok()
                        != x.respuesta.parse::<Fraccion>().ok()
                {
                    err.push(format!(
                        "{l} asistido {k}: el último paso debe dar la respuesta del ejemplo"
                    ));
                }
            }
            val_grafico(&x.grafico, &l, &mut err);
        }
        let ex = &e1.explicar;
        if ex.pistas.len() != 2 {
            err.push(format!("{l}: explicar necesita 2 pistas socráticas"));
        }
        if ex.claves.is_empty() || ex.criterio.trim().is_empty() {
            err.push(format!("{l}: explicar necesita criterio y claves"));
        }
        for p in graficos::problemas(&ex.pista_grafica.grafico) {
            err.push(format!("{l}: explicar pista gráfica: {p}"));
        }
        if e1.repaso.is_empty() {
            err.push(format!("{l}: falta repaso"));
        }
        for bq in e1.teoria.iter().chain(e1.repaso.iter()) {
            val_grafico(&bq.grafico, &l, &mut err);
        }
    }
    if b.tareas.is_empty() {
        err.push("falta al menos una tarea".into());
    }
    for t in &b.tareas {
        if t.ejercicios.len() != 5 {
            err.push(format!("tarea {}: debe tener 5 ejercicios", t.id));
        }
        for e in &t.ejercicios {
            id_unico(&e.id, &mut err);
            if e.nivel > t.nivel {
                err.push(format!("{}: nivel mayor al de la tarea", e.id));
            }
            val_ejercicio(e, true, &intereses, &mut err);
        }
    }
    if b.evaluaciones.is_empty() {
        err.push("falta al menos una evaluación".into());
    }
    for ev in &b.evaluaciones {
        if ev.preguntas.len() < 4 {
            err.push(format!("evaluación {}: al menos 4 preguntas", ev.id));
        }
        if !ev.preguntas.iter().any(|p| p.fallada) {
            err.push(format!(
                "evaluación {}: al menos una fallada por defecto",
                ev.id
            ));
        }
        for p in &ev.preguntas {
            let e = &p.ejercicio;
            id_unico(&e.id, &mut err);
            val_ejercicio(e, true, &intereses, &mut err);
            let lect = aule_core::correccion::corregir(&e.into(), &p.respuesta_alumno);
            if p.fallada && lect.es_correcta() {
                err.push(format!(
                    "{}: marcada fallada pero respuesta_alumno es correcta",
                    e.id
                ));
            }
            if !p.fallada && !lect.es_correcta() {
                err.push(format!(
                    "{}: no fallada pero respuesta_alumno es incorrecta",
                    e.id
                ));
            }
        }
    }
    err
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_banco_carga_y_es_valido() {
        let b = cargar().expect("parsea");
        let e = validar(&b);
        assert!(e.is_empty(), "errores de contenido:\n{}", e.join("\n"));
    }

    #[test]
    fn ningun_similar_es_igual_a_su_ejercicio() {
        let b = cargar().unwrap();
        for n in &b.niveles {
            for e in &n.ejercicios {
                let s = e.similar.as_ref().unwrap();
                assert_ne!(
                    normalizar(&s.enunciado),
                    normalizar(&e.enunciado),
                    "{}",
                    e.id
                );
            }
        }
    }

    #[test]
    fn cada_nivel_tiene_los_5_angulos() {
        let b = cargar().unwrap();
        for n in &b.niveles {
            for a in Angulo::TODOS {
                assert!(
                    n.ejercicios.iter().any(|e| e.angulo == Some(a)),
                    "nivel {} {a:?}",
                    n.nivel
                );
            }
        }
    }

    #[test]
    fn graficos_generan_svg() {
        let b = cargar().unwrap();
        for n in &b.niveles {
            for e in &n.ejercicios {
                if let Some(g) = &e.grafico {
                    assert!(graficos::svg(g).starts_with("<svg"));
                }
                assert!(
                    graficos::svg(&e.pista_grafica.as_ref().unwrap().grafico).contains("</svg>")
                );
            }
        }
    }
}
