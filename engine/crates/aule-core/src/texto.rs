//! Utilidades de texto en español: normalizar, leer números y fracciones
//! dichas con palabras ("tres cuartos", "uno y medio", "siete doceavos").

use crate::fraccion::FraccionEscrita;

/// Minúsculas, sin tildes, signos de puntuación como espacio (salvo '/').
pub fn normalizar(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let c = match c {
            'á' | 'à' | 'ä' | 'Á' => 'a',
            'é' | 'è' | 'ë' | 'É' => 'e',
            'í' | 'ì' | 'ï' | 'Í' => 'i',
            'ó' | 'ò' | 'ö' | 'Ó' => 'o',
            'ú' | 'ù' | 'ü' | 'Ú' => 'u',
            'ñ' | 'Ñ' => 'n',
            c => c,
        };
        let c = c.to_ascii_lowercase();
        if c.is_alphanumeric() || c == '/' || c == ' ' || c == '<' || c == '>' || c == '=' {
            out.push(c);
        } else {
            out.push(' ');
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Contiene la palabra (o frase) completa, ya normalizada.
pub fn contiene_palabra(texto_norm: &str, palabra: &str) -> bool {
    let p = normalizar(palabra);
    if p.is_empty() {
        return false;
    }
    let t = format!(" {texto_norm} ");
    // Coincidencia por prefijo de palabra: "simplific" encuentra "simplificar".
    t.contains(&format!(" {p}"))
}

fn unidad(p: &str) -> Option<i64> {
    Some(match p {
        "cero" => 0,
        "un" | "uno" | "una" => 1,
        "dos" => 2,
        "tres" => 3,
        "cuatro" => 4,
        "cinco" => 5,
        "seis" => 6,
        "siete" => 7,
        "ocho" => 8,
        "nueve" => 9,
        "diez" => 10,
        "once" => 11,
        "doce" => 12,
        "trece" => 13,
        "catorce" => 14,
        "quince" => 15,
        "dieciseis" => 16,
        "diecisiete" => 17,
        "dieciocho" => 18,
        "diecinueve" => 19,
        "veinte" => 20,
        "veintiuno" | "veintiun" | "veintiuna" => 21,
        "veintidos" => 22,
        "veintitres" => 23,
        "veinticuatro" => 24,
        "veinticinco" => 25,
        "veintiseis" => 26,
        "veintisiete" => 27,
        "veintiocho" => 28,
        "veintinueve" => 29,
        "treinta" => 30,
        "cuarenta" => 40,
        "cincuenta" => 50,
        "sesenta" => 60,
        "setenta" => 70,
        "ochenta" => 80,
        "noventa" => 90,
        "cien" => 100,
        _ => return None,
    })
}

/// Lee un número (cifras o palabras) desde `toks[i..]`. Devuelve (valor, tokens consumidos).
fn numero(toks: &[&str], i: usize) -> Option<(i64, usize)> {
    let t = *toks.get(i)?;
    if let Ok(n) = t.parse::<i64>() {
        return Some((n, 1));
    }
    // Por voz un número suelto llega a veces en plural («Cincos» por
    // «Cinco.»): es el mismo número. «Unos» es otra palabra.
    let n = unidad(t).or_else(|| t.strip_suffix('s').and_then(unidad).filter(|n| *n != 1))?;
    // "treinta y dos"
    if n >= 30 && n % 10 == 0 && toks.get(i + 1) == Some(&"y") {
        if let Some(u) = toks.get(i + 2).and_then(|x| unidad(x)) {
            if u < 10 {
                return Some((n + u, 3));
            }
        }
    }
    Some((n, 1))
}

/// Números que el oído confunde al transcribir la voz: «dos» y «doce» suenan
/// casi igual, y «tres» y «trece» también, así que cada uno llega escrito
/// por el otro (2026-11-26: «Dos» escrito «Doce» en cuatro de diez voces de
/// niño).
const SE_OYEN_PARECIDO: [(i64, i64); 2] = [(2, 12), (3, 13)];

/// ¿Lo leído es un número que suena casi igual que el esperado, sin serlo?
pub fn se_oye_como(leida: &FraccionEscrita, esperada: &FraccionEscrita) -> bool {
    let entero = |f: &FraccionEscrita| (f.entero.is_none() && f.den == 1).then_some(f.num);
    match (entero(leida), entero(esperada)) {
        (Some(a), Some(b)) => SE_OYEN_PARECIDO
            .iter()
            .any(|&(x, y)| (a, b) == (x, y) || (a, b) == (y, x)),
        _ => false,
    }
}

/// Denominador dicho con palabras: "medio", "tercios", "doceavos"...
fn denominador(p: &str) -> Option<i64> {
    let s = p.strip_suffix('s').unwrap_or(p);
    let d = match s {
        "medio" | "media" => 2,
        "tercio" | "tercera" | "tercer" => 3,
        "cuarto" | "cuarta" => 4,
        "quinto" | "quinta" => 5,
        "sexto" | "sexta" => 6,
        "septimo" | "setimo" | "septima" | "setima" => 7,
        "octavo" | "octava" => 8,
        "noveno" | "novena" => 9,
        "decimo" | "decima" => 10,
        "centesimo" => 100,
        _ => {
            let raiz = s.strip_suffix("avo").or_else(|| s.strip_suffix("ava"))?;
            // "onceavo", "doceavo", "dieciseisavo", "veinteavo" (veint-e-avo).
            let candidatos = [raiz.to_string(), format!("{raiz}e"), format!("{raiz}o")];
            return candidatos
                .iter()
                .find_map(|c| unidad(c))
                .filter(|n| *n >= 11);
        }
    };
    Some(d)
}

/// Busca la primera fracción, mixto o entero escrito con cifras o palabras.
pub fn leer_fraccion(texto: &str) -> Option<FraccionEscrita> {
    let n = normalizar(texto)
        .replace(" / ", "/")
        .replace("/ ", "/")
        .replace(" /", "/");
    let toks: Vec<&str> = n.split_whitespace().collect();

    // 1) Cifras: "a/b", con posible entero antes ("1 1/2").
    for (i, t) in toks.iter().enumerate() {
        if let Some((a, b)) = t.split_once('/') {
            if let (Ok(a), Ok(b)) = (a.parse::<i64>(), b.parse::<i64>()) {
                if b == 0 {
                    return None;
                }
                let entero = if i > 0 {
                    toks[i - 1].parse::<i64>().ok().or_else(|| {
                        // "1 y 1/2", "2 enteros 1/3"
                        if i > 1 && (toks[i - 1] == "y" || toks[i - 1].starts_with("entero")) {
                            toks[i - 2].parse::<i64>().ok()
                        } else {
                            None
                        }
                    })
                } else {
                    None
                };
                return Some(FraccionEscrita {
                    entero,
                    num: a,
                    den: b,
                });
            }
        }
    }

    // 2) Palabras: "<n> <denominador>", "<n> sobre <m>", "<n> entre <m>",
    //    "<e> y <n> <den>", "<e> enteros y <n> <den>", "<e> y medio".
    let mut i = 0;
    while i < toks.len() {
        if let Some((a, k)) = numero(&toks, i) {
            let j = i + k;
            // a sobre/entre b
            if matches!(toks.get(j), Some(&"sobre") | Some(&"entre")) {
                if let Some((b, _)) = numero(&toks, j + 1) {
                    if b != 0 {
                        return Some(FraccionEscrita {
                            entero: None,
                            num: a,
                            den: b,
                        });
                    }
                }
            }
            // a <den>
            if let Some(d) = toks.get(j).and_then(|t| denominador(t)) {
                return Some(FraccionEscrita {
                    entero: None,
                    num: a,
                    den: d,
                });
            }
            // e [enteros] y ...
            let mut jj = j;
            if toks
                .get(jj)
                .map(|t| t.starts_with("entero"))
                .unwrap_or(false)
            {
                jj += 1;
            }
            if toks.get(jj) == Some(&"y") {
                if toks.get(jj + 1).map(|t| *t == "medio" || *t == "media") == Some(true) {
                    return Some(FraccionEscrita {
                        entero: Some(a),
                        num: 1,
                        den: 2,
                    });
                }
                if let Some((b, k2)) = numero(&toks, jj + 1) {
                    if let Some(d) = toks.get(jj + 1 + k2).and_then(|t| denominador(t)) {
                        return Some(FraccionEscrita {
                            entero: Some(a),
                            num: b,
                            den: d,
                        });
                    }
                }
            }
            // Un entero suelto (solo si no hay más fracciones después).
            let resto = &toks[j..];
            let hay_mas = resto
                .iter()
                .any(|t| denominador(t).is_some() || t.contains('/'));
            if !hay_mas {
                return Some(FraccionEscrita {
                    entero: None,
                    num: a,
                    den: 1,
                });
            }
            i = j;
        } else {
            i += 1;
        }
    }
    None
}

/// Lee la respuesta final de un texto: si dice "… es / da / sale / igual a …",
/// se toma lo que viene después de la última de esas palabras ("1/4 es igual a 2/8" → 2/8).
pub fn leer_respuesta(texto: &str) -> Option<FraccionEscrita> {
    let n = normalizar(texto);
    let toks: Vec<&str> = n.split_whitespace().collect();
    let marcas = [
        "es",
        "da",
        "sale",
        "salio",
        "igual",
        "resultado",
        "queda",
        "son",
        "=",
    ];
    for (i, t) in toks.iter().enumerate().rev() {
        if marcas.contains(t) && i + 1 < toks.len() {
            if let Some(f) = leer_fraccion(&toks[i + 1..].join(" ")) {
                return Some(f);
            }
        }
    }
    leer_fraccion(texto)
}

/// Cómo entendió Aule lo que escribió el Alumno, en palabras simples
/// ("3 sobre 4", "1 entero y 1 sobre 2", "12"). Sirve para la vista previa del campo.
pub fn describir(f: &FraccionEscrita) -> String {
    match f.entero {
        Some(e) if f.num != 0 => format!(
            "{e} {} y {} sobre {}",
            if e == 1 { "entero" } else { "enteros" },
            f.num,
            f.den
        ),
        Some(e) => e.to_string(),
        None if f.den == 1 => f.num.to_string(),
        None => format!("{} sobre {}", f.num, f.den),
    }
}

/// Analiza lo escrito en el campo de respuesta: `Some((forma escrita, descripción))`.
pub fn entender(texto: &str) -> Option<(String, String)> {
    let t = texto.trim();
    if t.is_empty() || t.chars().count() > 60 {
        return None;
    }
    // Barras de más ("1/2/3") o denominador cero no son una fracción.
    if t.matches('/').count() > 1 {
        return None;
    }
    let f = leer_respuesta(t)?;
    if f.den == 0 {
        return None;
    }
    Some((f.to_string(), describir(&f)))
}

/// "No sé", "ni idea", "no me sale"...
pub fn es_no_se(texto: &str) -> bool {
    let n = normalizar(texto);
    [
        "no se",
        "no lo se",
        "ni idea",
        "no me sale",
        "no entiendo",
        "no tengo idea",
        "nose",
    ]
    .iter()
    .any(|p| n == *p || n.starts_with(&format!("{p} ")) || n.contains(&format!(" {p}")))
        && leer_fraccion(texto).is_none()
}

/// Elige una opción (p. ej. "Verdadero", "<", "Ana", "5/6") dentro del texto.
pub fn leer_opcion(texto: &str, opciones: &[String]) -> Option<usize> {
    let n = normalizar(texto);
    let toks: Vec<&str> = n.split_whitespace().collect();
    // Coincidencia exacta primero.
    for (k, o) in opciones.iter().enumerate() {
        if normalizar(o) == n {
            return Some(k);
        }
    }
    // Sinónimos de símbolos y V/F.
    let sinonimos = |o: &str| -> Vec<&'static str> {
        match normalizar(o).as_str() {
            "verdadero" => vec!["verdadero", "v", "verdad", "cierto", "si es", "correcto"],
            "falso" => vec!["falso", "f", "mentira", "no es", "incorrecto"],
            "<" => vec!["<", "menor"],
            ">" => vec![">", "mayor"],
            "=" => vec!["=", "igual", "iguales", "equivalentes"],
            _ => vec![],
        }
    };
    let mut hallada: Option<(usize, usize)> = None; // (posición en texto, opción)
    for (k, o) in opciones.iter().enumerate() {
        let mut formas: Vec<String> = sinonimos(o).iter().map(|s| s.to_string()).collect();
        formas.push(normalizar(o));
        for f in formas {
            let pos = if f.len() <= 1 {
                toks.iter().position(|t| *t == f)
            } else {
                n.find(&f).filter(|_| contiene_palabra(&n, &f))
            };
            if let Some(p) = pos {
                if hallada.map(|(hp, _)| p < hp).unwrap_or(true) {
                    hallada = Some((p, k));
                }
            }
        }
    }
    if let Some((_, k)) = hallada {
        return Some(k);
    }
    // Una opción escrita como fracción o número («5/6») también se dice, y
    // por voz llega en palabras («cinco sextos», «cinco sobre seis»): se
    // compara lo que dijo el Alumno, leído como su respuesta, con cada opción
    // tal como está escrita. Vale la forma escrita, no el valor: «diez
    // doceavos» no es la opción «5/6».
    let dicha = leer_respuesta(texto)?;
    opciones
        .iter()
        .position(|o| leer_fraccion(o) == Some(dicha))
}

/// ¿El texto es un sí?
pub fn es_si(texto: &str) -> bool {
    let n = normalizar(texto);
    let t: Vec<&str> = n.split_whitespace().collect();
    [
        "si", "claro", "dale", "ok", "okay", "vale", "bueno", "listo", "ya", "perfecto", "sip",
        "obvio", "vamos", "genial",
    ]
    .iter()
    .any(|w| t.first() == Some(w) || t.contains(w))
        && !es_no(texto)
}

/// ¿El texto es un no?
pub fn es_no(texto: &str) -> bool {
    let n = normalizar(texto);
    let t: Vec<&str> = n.split_whitespace().collect();
    t.first() == Some(&"no") || n.contains("no quiero") || n.contains("ninguno") || n == "nop"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fraccion::Fraccion;

    fn v(s: &str) -> Fraccion {
        leer_fraccion(s).unwrap().valor()
    }

    #[test]
    fn palabras() {
        assert_eq!(v("tres cuartos"), Fraccion::new(3, 4));
        assert_eq!(v("Creo que es un medio"), Fraccion::new(1, 2));
        assert_eq!(v("siete doceavos"), Fraccion::new(7, 12));
        assert_eq!(v("once quinceavos"), Fraccion::new(11, 15));
        assert_eq!(v("uno y medio"), Fraccion::new(3, 2));
        assert_eq!(v("dos enteros y un cuarto"), Fraccion::new(9, 4));
        assert_eq!(v("cinco sobre ocho"), Fraccion::new(5, 8));
        assert_eq!(v("me sale 3/4"), Fraccion::new(3, 4));
        assert_eq!(v("1 1/2"), Fraccion::new(3, 2));
        assert_eq!(v("quince"), Fraccion::entero(15));
        assert_eq!(v("veinte avos"), Fraccion::entero(20));
        assert!(leer_fraccion("2 y 1/3").unwrap().es_mixto());
        assert_eq!(v("cinco veinteavos"), Fraccion::new(5, 20));
        assert_eq!(
            leer_respuesta("1/4 es igual a 2/8").unwrap().to_string(),
            "2/8"
        );
        assert_eq!(
            leer_respuesta("me salió tres cuartos").unwrap().valor(),
            Fraccion::new(3, 4)
        );
        assert_eq!(leer_respuesta("5/6").unwrap().valor(), Fraccion::new(5, 6));
        assert!(es_no_se("No sé"));
        // Campo de respuesta: vista previa "Aule entiende…".
        assert_eq!(entender("3/4"), Some(("3/4".into(), "3 sobre 4".into())));
        assert_eq!(entender("3 / 4"), Some(("3/4".into(), "3 sobre 4".into())));
        assert_eq!(
            entender(" 1 1/2 "),
            Some(("1 1/2".into(), "1 entero y 1 sobre 2".into()))
        );
        assert_eq!(entender("2 3/5").unwrap().1, "2 enteros y 3 sobre 5");
        assert_eq!(
            entender("tres cuartos"),
            Some(("3/4".into(), "3 sobre 4".into()))
        );
        assert_eq!(entender("12"), Some(("12".into(), "12".into())));
        assert_eq!(entender("abc"), None);
        assert_eq!(entender(""), None);
        assert_eq!(entender("3/0"), None);
        assert_eq!(entender("1/2/3"), None);
        assert_eq!(entender("/"), None);
        assert!(es_no_se("la verdad no se como"));
        assert!(!es_no_se("no sé, creo que 3/4"));
        assert_eq!(v("tres veinticuatroavos"), Fraccion::new(3, 24));
    }

    #[test]
    fn un_numero_en_plural_es_el_mismo_numero() {
        // «Cinco.» llega a veces escrito «Cincos».
        assert_eq!(v("Cincos"), Fraccion::new(5, 1));
        assert_eq!(v("cuatros"), Fraccion::new(4, 1));
        assert_eq!(v("doces"), Fraccion::new(12, 1));
        // Los que ya terminan en s son ellos mismos.
        assert_eq!(v("dos"), Fraccion::new(2, 1));
        assert_eq!(v("seis"), Fraccion::new(6, 1));
        // «Unos» no es el número uno.
        assert!(leer_fraccion("unos").is_none());
        assert_eq!(v("unos tres cuartos"), Fraccion::new(3, 4));
    }

    #[test]
    fn numeros_que_se_oyen_parecido() {
        let n = |x: i64| FraccionEscrita {
            entero: None,
            num: x,
            den: 1,
        };
        assert!(se_oye_como(&n(12), &n(2)));
        assert!(se_oye_como(&n(2), &n(12)));
        assert!(se_oye_como(&n(13), &n(3)));
        // El mismo número no es otro que suena parecido, ni lo es uno cualquiera.
        assert!(!se_oye_como(&n(2), &n(2)));
        assert!(!se_oye_como(&n(5), &n(2)));
        assert!(!se_oye_como(&n(12), &n(3)));
        // Solo números enteros: 12/5 no se confunde con 2.
        let f = FraccionEscrita {
            entero: None,
            num: 12,
            den: 5,
        };
        assert!(!se_oye_como(&f, &n(2)));
    }

    #[test]
    fn opciones() {
        let vf = vec!["Verdadero".to_string(), "Falso".to_string()];
        assert_eq!(leer_opcion("Es falso porque...", &vf), Some(1));
        assert_eq!(leer_opcion("V", &vf), Some(0));
        let s = vec!["<".to_string(), ">".to_string(), "=".to_string()];
        assert_eq!(leer_opcion("es mayor", &s), Some(1));
        assert_eq!(leer_opcion("=", &s), Some(2));
    }

    #[test]
    fn una_opcion_escrita_como_fraccion_se_elige_al_decirla() {
        // «¿Cuál de las fracciones originales es mayor?», con sus dos opciones.
        let o = vec!["2/3".to_string(), "5/6".to_string()];
        // Escrita o tocada, como siempre.
        assert_eq!(leer_opcion("5/6", &o), Some(1));
        // Dicha: por voz llega en palabras.
        assert_eq!(leer_opcion("Cinco sextos", &o), Some(1));
        assert_eq!(leer_opcion("Cinco sextos,", &o), Some(1));
        assert_eq!(leer_opcion("cinco sobre seis", &o), Some(1));
        assert_eq!(leer_opcion("la mayor es cinco sextos", &o), Some(1));
        assert_eq!(leer_opcion("dos tercios", &o), Some(0));
        // Lo que no es una de las opciones no elige ninguna, aunque valga lo mismo.
        assert_eq!(leer_opcion("diez doceavos", &o), None);
        assert_eq!(leer_opcion("cuatro sextos", &o), None);
        assert_eq!(leer_opcion("doce", &o), None);
        assert_eq!(leer_opcion("mi perro se llama Rocky", &o), None);
        // Opciones que son números enteros.
        let n = vec!["2".to_string(), "5".to_string()];
        assert_eq!(leer_opcion("cinco", &n), Some(1));
        assert_eq!(leer_opcion("tres", &n), None);
        // Las opciones en palabras no se leen como números.
        let vf = vec!["Verdadero".to_string(), "Falso".to_string()];
        assert_eq!(leer_opcion("cinco sextos", &vf), None);
    }

    #[test]
    fn si_no() {
        assert!(es_si("Sí, dale"));
        assert!(es_no("no, gracias"));
        assert!(!es_si("no"));
    }
}
