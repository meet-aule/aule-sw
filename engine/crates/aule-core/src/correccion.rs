//! Corrección determinista: primero se intenta sin IA (respuesta escrita que
//! se parsea como fracción, mixto o entero, comparando por valor y por forma).

use crate::banco::{Ejercicio, Forma};
use crate::fraccion::{mcd, Fraccion, FraccionEscrita};
use crate::texto;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Veredicto {
    Correcta,
    /// El valor es correcto pero no está en la forma pedida.
    FormaIncorrecta {
        pedida: Forma,
    },
    Incorrecta,
    /// No se pudo leer una respuesta en el texto.
    Ilegible,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Lectura {
    pub leida: Option<String>,
    pub veredicto: Veredicto,
}

impl Lectura {
    pub fn es_correcta(&self) -> bool {
        self.veredicto == Veredicto::Correcta
    }
}

/// Lo mínimo para corregir: respuesta canónica, opciones y forma.
pub struct Clave<'a> {
    pub respuesta: &'a str,
    pub opciones: &'a [String],
    pub forma: Forma,
}

impl<'a> From<&'a Ejercicio> for Clave<'a> {
    fn from(e: &'a Ejercicio) -> Self {
        Clave {
            respuesta: &e.respuesta,
            opciones: &e.opciones,
            forma: e.forma,
        }
    }
}

pub fn cumple_forma(e: &FraccionEscrita, forma: Forma) -> bool {
    match forma {
        Forma::Cualquiera => true,
        Forma::Simplificada => {
            if e.es_mixto() {
                mcd(e.num, e.den) == 1 && e.num < e.den
            } else {
                e.esta_simplificada()
            }
        }
        Forma::Mixto => {
            let v = e.valor();
            if v.es_entero() {
                e.es_entero_escrito() || (e.entero.is_some() && e.num == 0)
            } else if v < Fraccion::entero(1) {
                // Una fracción propia no tiene parte entera: se acepta tal cual.
                e.entero.is_none()
            } else {
                e.es_mixto() && e.num < e.den
            }
        }
        Forma::Impropia => e.entero.is_none(),
        Forma::Entero => e.es_entero_escrito(),
    }
}

pub fn corregir(clave: &Clave, texto_alumno: &str) -> Lectura {
    if !clave.opciones.is_empty() {
        let Some(k) = texto::leer_opcion(texto_alumno, clave.opciones) else {
            return Lectura {
                leida: None,
                veredicto: Veredicto::Ilegible,
            };
        };
        let elegida = &clave.opciones[k];
        let ok = texto::normalizar(elegida) == texto::normalizar(clave.respuesta);
        return Lectura {
            leida: Some(elegida.clone()),
            veredicto: if ok {
                Veredicto::Correcta
            } else {
                Veredicto::Incorrecta
            },
        };
    }
    let Some(escrita) = texto::leer_respuesta(texto_alumno) else {
        return Lectura {
            leida: None,
            veredicto: Veredicto::Ilegible,
        };
    };
    let esperado: Fraccion = match clave.respuesta.parse() {
        Ok(f) => f,
        Err(_) => {
            return Lectura {
                leida: Some(escrita.to_string()),
                veredicto: Veredicto::Ilegible,
            }
        }
    };
    let veredicto = if escrita.valor() != esperado {
        Veredicto::Incorrecta
    } else if cumple_forma(&escrita, clave.forma) {
        Veredicto::Correcta
    } else {
        Veredicto::FormaIncorrecta {
            pedida: clave.forma,
        }
    };
    Lectura {
        leida: Some(escrita.to_string()),
        veredicto,
    }
}

/// Respaldo sin IA para juzgar una explicación: cuenta grupos de palabras clave.
pub fn explicacion_por_claves(texto: &str, claves: &[Vec<String>], minimo: usize) -> bool {
    let n = texto::normalizar(texto);
    if n.split_whitespace().count() < 3 {
        return false;
    }
    if claves.is_empty() {
        return true;
    }
    let tocadas = claves
        .iter()
        .filter(|g| g.iter().any(|p| texto::contiene_palabra(&n, p)))
        .count();
    tocadas >= minimo.min(claves.len()).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(resp: &str, forma: Forma, txt: &str) -> Veredicto {
        corregir(
            &Clave {
                respuesta: resp,
                opciones: &[],
                forma,
            },
            txt,
        )
        .veredicto
    }

    /// Por voz una opción escrita en cifras llega en palabras: se corrige igual.
    #[test]
    fn una_opcion_en_cifras_dicha_en_palabras() {
        let opciones = ["2/3".to_string(), "5/6".to_string()];
        let c = |txt: &str| {
            corregir(
                &Clave {
                    respuesta: "5/6",
                    opciones: &opciones,
                    forma: Forma::Cualquiera,
                },
                txt,
            )
        };
        let bien = c("Cinco sextos");
        assert_eq!(bien.veredicto, Veredicto::Correcta);
        assert_eq!(bien.leida.as_deref(), Some("5/6"));
        assert_eq!(c("dos tercios").veredicto, Veredicto::Incorrecta);
        assert_eq!(c("5/6").veredicto, Veredicto::Correcta);
        // Lo que no es ninguna de las dos no se lee como respuesta.
        assert_eq!(c("Doce").veredicto, Veredicto::Ilegible);
    }

    #[test]
    fn por_valor_y_forma() {
        assert_eq!(c("1/2", Forma::Cualquiera, "2/4"), Veredicto::Correcta);
        assert_eq!(
            c("1/2", Forma::Simplificada, "2/4"),
            Veredicto::FormaIncorrecta {
                pedida: Forma::Simplificada
            }
        );
        assert_eq!(c("3/2", Forma::Mixto, "1 1/2"), Veredicto::Correcta);
        assert!(matches!(
            c("3/2", Forma::Mixto, "3/2"),
            Veredicto::FormaIncorrecta { .. }
        ));
        assert_eq!(c("3/2", Forma::Impropia, "3/2"), Veredicto::Correcta);
        assert_eq!(c("3/4", Forma::Cualquiera, "4/3"), Veredicto::Incorrecta);
        assert_eq!(c("3/4", Forma::Cualquiera, "no sé"), Veredicto::Ilegible);
        assert_eq!(c("15", Forma::Entero, "quince"), Veredicto::Correcta);
    }

    #[test]
    fn claves() {
        let k = vec![
            vec!["partes iguales".to_string(), "iguales".to_string()],
            vec!["denominador".to_string(), "abajo".to_string()],
        ];
        assert!(explicacion_por_claves(
            "el de abajo dice en cuántas partes iguales",
            &k,
            2
        ));
        assert!(!explicacion_por_claves("porque sí", &k, 2));
    }
}
