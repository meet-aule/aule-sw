//! Tipos del banco de contenido. Los datos viven en el crate `contenido`
//! (TOML embebido); aquí solo está la forma, para que el motor no dependa de IO.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Ángulo de un ejercicio de Etapa 2 (E2-01: "desde diferentes ángulos").
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Angulo {
    /// Representación gráfica.
    Grafica,
    /// Cálculo directo.
    Calculo,
    /// Problema en contexto.
    Contexto,
    /// Encontrar el error, o verdadero y falso con justificación.
    Error,
    /// Dato faltante o problema inverso.
    Inverso,
}

impl Angulo {
    pub const TODOS: [Angulo; 5] = [
        Angulo::Grafica,
        Angulo::Calculo,
        Angulo::Contexto,
        Angulo::Error,
        Angulo::Inverso,
    ];
}

/// Forma en que se acepta la respuesta.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Forma {
    /// Cualquier forma equivalente (2/4 vale por 1/2; 1 1/2 vale por 3/2).
    #[default]
    Cualquiera,
    /// Debe estar simplificada (fracción irreducible, o mixto con parte propia irreducible, o entero).
    Simplificada,
    /// Debe escribirse como número mixto (o entero si no hay resto).
    Mixto,
    /// Debe escribirse como fracción impropia (sin parte entera).
    Impropia,
    /// Debe ser un número entero.
    Entero,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FilaBarra {
    pub partes: u32,
    pub sombreadas: u32,
    #[serde(default)]
    pub etiqueta: Option<String>,
}

/// Gráfico que se dibuja como SVG (el render está en el crate `contenido`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "tipo", rename_all = "lowercase")]
pub enum Grafico {
    /// Una barra dividida en `partes` iguales con `sombreadas` pintadas.
    Barra {
        partes: u32,
        sombreadas: u32,
        #[serde(default)]
        etiqueta: Option<String>,
    },
    /// Varias barras, una debajo de otra, del mismo largo (equivalencias, comparar, sumar).
    Barras { filas: Vec<FilaBarra> },
    /// Un círculo (pizza/torta) en `partes` iguales.
    Circulo { partes: u32, sombreadas: u32 },
    /// Varios círculos de `partes` cada uno, `sombreadas` en total (para mixtos/impropias).
    Circulos { partes: u32, sombreadas: u32 },
    /// Recta numérica de `desde` a `hasta`, cada unidad partida en `divisiones`.
    /// `marca` (opcional) es una fracción "a/b" que se señala con un punto.
    /// `pregunta = true` pone un "?" en la marca en vez de su valor.
    Recta {
        #[serde(default)]
        desde: i64,
        hasta: i64,
        divisiones: u32,
        #[serde(default)]
        marca: Option<String>,
        #[serde(default)]
        pregunta: bool,
    },
    /// Un conjunto de `total` objetos, `marcados` resaltados (parte de un conjunto).
    Conjunto {
        total: u32,
        marcados: u32,
        #[serde(default)]
        icono: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PistaGrafica {
    pub texto: String,
    pub grafico: Grafico,
}

/// Ejercicio similar con su paso a paso (PIS-03: nunca el mismo ejercicio).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Similar {
    pub enunciado: String,
    #[serde(default)]
    pub grafico: Option<Grafico>,
    pub pasos: Vec<String>,
    pub respuesta: String,
    /// Expresión que comprueba la respuesta del similar.
    pub verificar: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Ejercicio {
    pub id: String,
    #[serde(default)]
    pub angulo: Option<Angulo>,
    /// Nivel del ejercicio. En los niveles lo completa el cargador; en tareas,
    /// evaluaciones y simulación se escribe explícito.
    #[serde(default)]
    pub nivel: u8,
    pub enunciado: String,
    /// Enunciados alternativos por interés del alumno, con los mismos números.
    /// Claves: futbol, videojuegos, dinosaurios, cocina, musica.
    #[serde(default)]
    pub contextos: BTreeMap<String, String>,
    #[serde(default)]
    pub grafico: Option<Grafico>,
    /// Respuesta canónica: una fracción ("3/4", "2", "1 1/2") o, si hay
    /// `opciones`, el texto de la opción correcta.
    pub respuesta: String,
    #[serde(default)]
    pub opciones: Vec<String>,
    #[serde(default)]
    pub forma: Forma,
    /// Expresión que verifica la respuesta con el tipo Fraccion
    /// (ver `expr`). Para respuestas numéricas debe dar el mismo valor;
    /// para opciones, una comparación que dé verdadero (o falso si la respuesta es "Falso").
    pub verificar: String,
    #[serde(default)]
    pub pide_explicacion: bool,
    #[serde(default)]
    pub criterio_explicacion: Option<String>,
    /// Respaldo sin IA: grupos de palabras; la explicación cuenta si toca al menos `minimo_claves` grupos.
    #[serde(default)]
    pub claves_explicacion: Vec<Vec<String>>,
    #[serde(default = "uno")]
    pub minimo_claves: usize,
    pub tiempo_s: u32,
    #[serde(default)]
    pub pistas: Vec<String>,
    #[serde(default)]
    pub pista_grafica: Option<PistaGrafica>,
    #[serde(default)]
    pub similar: Option<Similar>,
}

fn uno() -> usize {
    1
}

impl Ejercicio {
    /// Enunciado ambientado según el interés (si existe), si no el neutro.
    pub fn enunciado_para(&self, interes: Option<&str>) -> &str {
        interes
            .and_then(|i| self.contextos.get(i))
            .map(|s| s.as_str())
            .unwrap_or(&self.enunciado)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BloqueTeoria {
    pub texto: String,
    #[serde(default)]
    pub grafico: Option<Grafico>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EjemploNoAsistido {
    pub enunciado: String,
    #[serde(default)]
    pub grafico: Option<Grafico>,
    pub pasos: Vec<String>,
    pub respuesta: String,
    pub verificar: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PasoAsistido {
    /// Lo que Aule le recuerda/pide en este paso.
    pub indicacion: String,
    /// Respuesta del paso (fracción/entero, o una de `opciones`).
    pub respuesta: String,
    #[serde(default)]
    pub opciones: Vec<String>,
    /// Pregunta guía si se equivoca en el paso (sin dar la respuesta).
    pub ayuda: String,
    /// Cómo se resuelve el paso, se muestra si se vuelve a equivocar (es un ejemplo, no su ejercicio).
    pub solucion: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EjemploAsistido {
    pub enunciado: String,
    #[serde(default)]
    pub grafico: Option<Grafico>,
    /// La secuencia de pasos que Aule recuerda (nombres cortos).
    pub secuencia: Vec<String>,
    pub pasos: Vec<PasoAsistido>,
    pub respuesta: String,
    pub verificar: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PreguntaExplicar {
    pub pregunta: String,
    pub criterio: String,
    pub claves: Vec<Vec<String>>,
    #[serde(default = "dos")]
    pub minimo_claves: usize,
    pub pistas: Vec<String>,
    pub pista_grafica: PistaGrafica,
}

fn dos() -> usize {
    2
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Etapa1 {
    /// Teoría que parte del nivel anterior (E1-02). Cada bloque es un turno de Aule.
    pub teoria: Vec<BloqueTeoria>,
    pub no_asistidos: Vec<EjemploNoAsistido>,
    pub asistidos: Vec<EjemploAsistido>,
    pub explicar: PreguntaExplicar,
    /// Repaso conceptual si agota las pistas al explicar (E1-05).
    pub repaso: Vec<BloqueTeoria>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NivelContenido {
    pub nivel: u8,
    pub titulo: String,
    /// Nombre corto para el informe ("sumar fracciones con distinto denominador").
    pub subtema: String,
    /// [PROPUESTA] Cómo lo dice Aule en voz alta al contar el plan, en pocas
    /// palabras ("las fracciones equivalentes"): el título y el subtema son
    /// largos para oírlos en una lista.
    pub nombre_corto: String,
    pub tamizaje: Vec<Ejercicio>,
    pub etapa1: Etapa1,
    pub ejercicios: Vec<Ejercicio>,
    pub simulacion: Vec<Ejercicio>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Tarea {
    pub id: String,
    pub titulo: String,
    pub nivel: u8,
    pub ejercicios: Vec<Ejercicio>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PreguntaEvaluacion {
    pub ejercicio: Ejercicio,
    /// Lo que el alumno respondió en la evaluación real (para la corrección).
    pub respuesta_alumno: String,
    /// Si en el ajuste rápido viene marcada como fallada.
    #[serde(default)]
    pub fallada: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Evaluacion {
    pub id: String,
    pub titulo: String,
    pub nivel: u8,
    pub preguntas: Vec<PreguntaEvaluacion>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Interes {
    pub clave: String,
    pub nombre: String,
    /// Palabras que, si aparecen en los intereses escritos, activan este interés.
    pub palabras: Vec<String>,
    /// Tema extracurricular que se sugiere con este interés (RUT-09).
    pub sugerencia: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Banco {
    pub curso: String,
    pub tema: String,
    pub grado: String,
    pub niveles: Vec<NivelContenido>,
    pub tareas: Vec<Tarea>,
    pub evaluaciones: Vec<Evaluacion>,
    pub intereses: Vec<Interes>,
}

impl Banco {
    pub fn nivel(&self, n: u8) -> &NivelContenido {
        self.niveles
            .iter()
            .find(|x| x.nivel == n)
            .unwrap_or_else(|| panic!("nivel {n} no existe en el banco"))
    }

    pub fn subtema(&self, n: u8) -> &str {
        &self.nivel(n).subtema
    }

    /// Detecta el interés principal a partir del texto libre de intereses.
    pub fn interes_de(&self, texto: &str) -> Option<&Interes> {
        let t = crate::texto::normalizar(texto);
        // El primero que aparezca en el texto, en orden de aparición.
        let mut mejor: Option<(usize, &Interes)> = None;
        for i in &self.intereses {
            for p in &i.palabras {
                let p = crate::texto::normalizar(p);
                // Palabra completa al inicio ("gol" no se activa con "golosinas");
                // palabras largas aceptan sufijos ("dinosaurio" → "dinosaurios").
                let pos = format!(" {t} ")
                    .match_indices(&format!(" {p}"))
                    .find_map(|(k, _)| {
                        let resto = &t[(k + p.len()).min(t.len())..];
                        let fin_palabra = resto
                            .chars()
                            .next()
                            .map(|c| !c.is_alphanumeric())
                            .unwrap_or(true);
                        (fin_palabra || p.len() > 4).then_some(k)
                    });
                if let Some(pos) = pos {
                    if mejor.map(|(m, _)| pos < m).unwrap_or(true) {
                        mejor = Some((pos, i));
                    }
                }
            }
        }
        mejor.map(|(_, i)| i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interes_por_palabra_completa() {
        let i = |c: &str, p: &[&str]| Interes {
            clave: c.into(),
            nombre: c.into(),
            palabras: p.iter().map(|s| s.to_string()).collect(),
            sugerencia: String::new(),
        };
        let b = Banco {
            curso: String::new(),
            tema: String::new(),
            grado: String::new(),
            niveles: vec![],
            tareas: vec![],
            evaluaciones: vec![],
            intereses: vec![
                i("futbol", &["gol", "fútbol"]),
                i("cocina", &["golosinas", "cocinar"]),
                i("dino", &["dinosaurio"]),
            ],
        };
        assert_eq!(
            b.interes_de("me gustan las golosinas").unwrap().clave,
            "cocina"
        );
        assert_eq!(b.interes_de("meter un gol").unwrap().clave, "futbol");
        assert_eq!(
            b.interes_de("Fútbol y dinosaurios").unwrap().clave,
            "futbol"
        );
        assert_eq!(b.interes_de("los dinosaurios").unwrap().clave, "dino");
    }
}
