//! Escenarios del motor de aule-core con el banco real.
//! (Viven aquí porque necesitan el contenido, y `contenido` depende de `aule-core`.)

use aule_core::config::Config;
use aule_core::modelo::{EstadoObjetivo, Objetivo, Perfil, TipoObjetivo};
use aule_core::motor::{Calificacion, Clase, Entrada, Esperando, Mensaje, Motor};
use aule_core::reloj::RelojManual;
use chrono::NaiveDate;
use std::sync::Arc;

fn hoy() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 11, 14).unwrap()
}

fn obj(id: u32, tipo: TipoObjetivo, dias: i64, nivel: Option<u8>) -> Objetivo {
    Objetivo {
        id,
        tipo,
        curso: "Matemáticas".into(),
        tema: "Fracciones".into(),
        fecha: Some(hoy() + chrono::Duration::days(dias)),
        sin_fecha_confirmado: false,
        nivel_objetivo: nivel,
        tarea_id: None,
        evaluacion_id: None,
        falladas: vec![],
        estado: EstadoObjetivo::Pendiente,
    }
}

struct Prueba {
    m: Motor,
    reloj: RelojManual,
    log: Vec<Mensaje>,
}

impl Prueba {
    fn new(nivel: Option<u8>, objetivos: Vec<Objetivo>) -> Self {
        let banco = Arc::new(contenido::cargar_validado().expect("banco válido"));
        let reloj = RelojManual::new();
        let mut perfil = Perfil::nuevo("Liam", "fútbol y dinosaurios", "Ana", hoy());
        if let Some(n) = nivel {
            perfil.niveles.insert("Fracciones".into(), n);
        }
        let m = Motor::new(
            Config::default(),
            banco,
            Arc::new(reloj.clone()),
            perfil,
            objetivos,
        );
        Prueba {
            m,
            reloj,
            log: vec![],
        }
    }

    fn con_perfil(perfil: Perfil, objetivos: Vec<Objetivo>) -> Self {
        let banco = Arc::new(contenido::cargar_validado().unwrap());
        let reloj = RelojManual::new();
        let m = Motor::new(
            Config::default(),
            banco,
            Arc::new(reloj.clone()),
            perfil,
            objetivos,
        );
        Prueba {
            m,
            reloj,
            log: vec![],
        }
    }

    fn e(&mut self, e: Entrada) -> Vec<Mensaje> {
        let r = self.m.entrada(e);
        self.log.extend(r.clone());
        r
    }

    fn iniciar(&mut self) {
        self.e(Entrada::Comenzar);
        self.e(Entrada::Texto("¡Listo, empecemos!".into()));
    }

    fn responder(&mut self, ok: bool) -> Vec<Mensaje> {
        self.e(Entrada::Calificada(Calificacion {
            respuesta_correcta: ok,
            explicacion_correcta: Some(ok),
            ..Default::default()
        }))
    }

    fn act(&self) -> String {
        self.m.actividad()
    }

    fn registro_tiene(&self, s: &str) -> bool {
        self.m.registro().iter().any(|r| r.contains(s))
    }

    /// Avanza la Etapa 1 completa respondiendo todo bien.
    fn pasar_e1(&mut self) {
        let mut guard = 0;
        while self.act().starts_with("etapa1") {
            guard += 1;
            assert!(guard < 100, "Etapa 1 no termina");
            match self.m.esperando() {
                Esperando::Conversacion { .. } => {
                    self.e(Entrada::Texto("Entendido, sigue".into()));
                }
                Esperando::Respuesta { .. } | Esperando::Explicacion { .. } => {
                    self.responder(true);
                }
                _ => panic!("estado inesperado en E1: {:?}", self.m.esperando()),
            }
        }
    }

    fn pasar_e2(&mut self) {
        while self.act().starts_with("etapa2") {
            self.responder(true);
        }
    }
}

fn texto(ms: &[Mensaje]) -> String {
    ms.iter()
        .map(|m| m.texto.clone())
        .collect::<Vec<_>>()
        .join("\n")
}

/// A8: bien, bien, mal, bien, bien = nivel 2. Mal, bien... = ningún nivel.
#[test]
fn a8_ultimo_consecutivo() {
    let r = [(1, true), (2, true), (3, false), (4, true), (5, true)];
    assert_eq!(Motor::ultimo_consecutivo(&r), 2);
    let r = [(1, false), (2, true), (3, true), (4, true), (5, true)];
    assert_eq!(Motor::ultimo_consecutivo(&r), 0);

    let mut p = Prueba::new(None, vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.iniciar();
    for ok in [true, true, false, true, true] {
        assert!(p.act().starts_with("tamizaje"));
        p.responder(ok);
    }
    assert_eq!(p.m.perfil.niveles["Fracciones"], 2);
    assert!(p.registro_tiene("TAM-03"));
    assert_eq!(p.act(), "etapa1:3:teoria");
}

/// A9: respuesta bien y explicación mal = incorrecta.
#[test]
fn a9_respuesta_bien_explicacion_mal() {
    let mut p = Prueba::new(None, vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.iniciar();
    p.e(Entrada::Calificada(Calificacion {
        respuesta_correcta: true,
        explicacion_correcta: Some(false),
        ..Default::default()
    }));
    for _ in 0..4 {
        p.responder(true);
    }
    assert_eq!(p.m.perfil.niveles["Fracciones"], 0);
}

/// A10: sin pistas en el tamizaje aunque apriete "Necesito ayuda".
#[test]
fn a10_sin_pistas_en_tamizaje() {
    let mut p = Prueba::new(None, vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.iniciar();
    let r = p.e(Entrada::Ayuda);
    assert!(r.iter().all(|m| m.clase != Clase::Pista));
    assert!(p.registro_tiene("PIS-04"));
    assert!(p.act().starts_with("tamizaje:1"));
}

/// A11: retomar el tamizaje en el nivel 3 con otra pregunta.
#[test]
fn a11_retomar_tamizaje() {
    let mut p = Prueba::new(None, vec![obj(1, TipoObjetivo::Tarea, 5, Some(4))]);
    p.iniciar();
    p.responder(true);
    p.responder(true);
    let id3 = p.m.ejercicio_actual().unwrap().id;
    p.responder(true);
    assert!(p.act().starts_with("tamizaje:4"));
    p.e(Entrada::SalirTamizaje);
    assert_eq!(p.m.perfil.niveles["Fracciones"], 3);
    assert!(p.registro_tiene("TAM-06"));
    // Sigue la sesión con el nivel 3 (no repite el tamizaje hoy).
    assert_eq!(p.act(), "etapa1:4:teoria");
    // Sesión siguiente.
    let (perfil, pend) = p.m.para_siguiente_sesion();
    let mut q = Prueba::con_perfil(perfil, pend);
    q.iniciar();
    assert_eq!(q.act(), "tamizaje:3");
    assert_ne!(q.m.ejercicio_actual().unwrap().id, id3, "otra pregunta");
}

/// [PROPUESTA] El calentamiento dice para qué es, según el objetivo.
#[test]
fn tam01_el_calentamiento_dice_para_que_es() {
    let resto = "vamos a hacer algunos ejercicios de calentamiento: son 5 preguntas, de la más fácil a la más difícil. En cada una dime tu respuesta y cómo lo pensaste.";
    for (objetivos, para) in [
        (
            vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))],
            "Para ayudarte a resolver tu tarea de la mejor forma",
        ),
        (
            vec![obj(1, TipoObjetivo::Preparacion, 5, Some(3))],
            "Para prepararte bien para tu evaluación",
        ),
        (
            vec![obj(1, TipoObjetivo::Correccion, -2, None)],
            "Para saber desde dónde empezar",
        ),
        // Sin tareas ni evaluaciones: el Alumno elige el tema y luego el calentamiento.
        (vec![], "Para saber desde dónde empezar"),
    ] {
        let elige_tema = objetivos.is_empty();
        let mut p = Prueba::new(None, objetivos);
        p.iniciar();
        if elige_tema {
            p.e(Entrada::Texto("Sí, fracciones".into()));
        }
        assert_eq!(p.act(), "tamizaje:1");
        let linea = format!("{para}, {resto}");
        assert!(
            p.log.iter().any(|m| m.texto == linea),
            "falta «{linea}» en:\n{}",
            texto(&p.log)
        );
    }
}

/// Responde las 5 preguntas del Tamizaje; devuelve lo que dijo Aule a la última.
fn hacer_tamizaje(p: &mut Prueba, respuestas: [bool; 5]) -> Vec<Mensaje> {
    let mut ultima = vec![];
    for ok in respuestas {
        assert!(p.act().starts_with("tamizaje"), "{}", p.act());
        ultima = p.responder(ok);
    }
    ultima
}

fn textos(ms: &[Mensaje]) -> Vec<&str> {
    ms.iter().map(|m| m.texto.as_str()).collect()
}

/// [PROPUESTA] Nivel 1 y tarea de nivel 3: al terminar el Tamizaje, Aule cuenta
/// qué va a reforzar antes de la tarea y para qué, y empieza por el primero.
#[test]
fn tam08_el_plan_se_le_cuenta_al_alumno() {
    let mut p = Prueba::new(None, vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.iniciar();
    let r = hacer_tamizaje(&mut p, [true, false, false, false, false]);
    assert_eq!(p.m.perfil.niveles["Fracciones"], 1);
    assert_eq!(p.act(), "etapa1:2:teoria");
    assert_eq!(
        textos(&r)[..3],
        [
            "¡Gracias! Esa era la última pregunta del Tamizaje.",
            "He analizado cómo te fue en los ejercicios, y antes de que hagamos la tarea, te voy a ayudar a reforzar las fracciones equivalentes y las sumas y restas con el mismo denominador. Esto es importante para que aprendas a hacer la tarea por tu cuenta.",
            "Etapa 1: Descubrimiento. Empecemos por las fracciones equivalentes.",
        ]
    );
    assert!(
        !texto(&r).contains("¡Terminamos el Tamizaje!"),
        "{}",
        texto(&r)
    );
    assert!(p.registro_tiene("Plan contado al Alumno: niveles 2 y 3"));
    // El nivel que sigue en el plan se presenta como siempre.
    p.pasar_e1();
    p.pasar_e2();
    assert_eq!(p.act(), "etapa1:3:teoria");
    assert!(texto(&p.log).contains(
        "Etapa 1: Descubrimiento. Vamos a aprender algo nuevo: suma y resta con igual denominador; mixtos e impropias."
    ));
}

/// [PROPUESTA] El plan según el objetivo; con un solo nivel se empieza sin
/// repetir su nombre. Sin ningún nivel o con el objetivo ya alcanzado no hay
/// plan: el cierre de siempre.
#[test]
fn tam08_el_plan_segun_el_objetivo_y_solo_si_hay_que_reforzar() {
    let casos = [
        (
            vec![obj(1, TipoObjetivo::Preparacion, 5, Some(4))],
            "He analizado cómo te fue en los ejercicios, y antes de que simulemos tu evaluación, te voy a ayudar a reforzar las sumas y restas con el mismo denominador y las sumas y restas con distinto denominador. Esto es importante para que en tu evaluación puedas resolver todo por tu cuenta.",
            "Etapa 1: Descubrimiento. Empecemos por las sumas y restas con el mismo denominador.",
        ),
        (
            // El nivel objetivo es el de las preguntas que falló (4).
            vec![obj(1, TipoObjetivo::Correccion, -2, None)],
            "He analizado cómo te fue en los ejercicios, y antes de que revisemos tu evaluación, te voy a ayudar a reforzar las sumas y restas con el mismo denominador y las sumas y restas con distinto denominador. Esto es importante para que puedas resolver por tu cuenta las preguntas que te salieron mal.",
            "Etapa 1: Descubrimiento. Empecemos por las sumas y restas con el mismo denominador.",
        ),
        (
            vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))],
            "He analizado cómo te fue en los ejercicios, y antes de que hagamos la tarea, te voy a ayudar a reforzar las sumas y restas con el mismo denominador. Esto es importante para que aprendas a hacer la tarea por tu cuenta.",
            "Etapa 1: Descubrimiento. ¡Empecemos!",
        ),
        (
            // Extracurricular: solo el nivel siguiente (RUT-04).
            vec![],
            "He analizado cómo te fue en los ejercicios, y ya sé desde dónde empezar: te voy a ayudar a aprender las sumas y restas con el mismo denominador.",
            "Etapa 1: Descubrimiento. ¡Empecemos!",
        ),
    ];
    for (objetivos, plan, empieza) in casos {
        let elige_tema = objetivos.is_empty();
        let mut p = Prueba::new(None, objetivos);
        p.iniciar();
        if elige_tema {
            p.e(Entrada::Texto("Sí, fracciones".into()));
        }
        let r = hacer_tamizaje(&mut p, [true, true, false, false, false]);
        assert_eq!(p.act(), "etapa1:3:teoria");
        assert_eq!(textos(&r)[1..3], [plan, empieza], "{}", texto(&r));
    }

    // Ningún nivel: se construye desde el principio, sin plan.
    let mut p = Prueba::new(None, vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.iniciar();
    let r = hacer_tamizaje(&mut p, [false; 5]);
    assert_eq!(p.act(), "etapa1:1:teoria");
    assert_eq!(
        textos(&r)[1..3],
        [
            "¡Terminamos el Tamizaje! Ya sé por dónde empezar: vamos a construir las fracciones desde el principio, paso a paso.",
            "Etapa 1: Descubrimiento. Vamos a aprender algo nuevo: leer, escribir y representar fracciones.",
        ]
    );
    // Ya tiene el nivel de la tarea: a la tarea, sin plan.
    let mut p = Prueba::new(None, vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.iniciar();
    let r = hacer_tamizaje(&mut p, [true, true, true, false, false]);
    assert_eq!(p.act(), "tarea:1");
    assert!(
        texto(&r).contains("lo del nivel 3 ya lo manejas"),
        "{}",
        texto(&r)
    );
    assert!(!texto(&p.log).contains("He analizado"), "{}", texto(&p.log));
}

/// A12: nivel 3 y tarea de nivel 3: directo a la tarea.
#[test]
fn a12_directo_a_la_tarea() {
    let mut p = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.iniciar();
    assert_eq!(p.act(), "tarea:1");
    assert!(p.registro_tiene("RUT-02"));
}

/// A13: nivel 1 y tarea de nivel 3: E1 y E2 del 2, luego del 3, luego la tarea.
#[test]
fn a13_ruta_hasta_el_objetivo() {
    let mut p = Prueba::new(Some(1), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.iniciar();
    assert_eq!(p.act(), "etapa1:2:teoria");
    p.pasar_e1();
    assert_eq!(p.act(), "etapa2:2:1");
    p.pasar_e2();
    assert_eq!(p.act(), "etapa1:3:teoria");
    p.pasar_e1();
    p.pasar_e2();
    assert_eq!(p.act(), "tarea:1");
}

/// A14: no logra explicar: pistas y luego repaso.
#[test]
fn a14_no_explica_pistas_y_repaso() {
    let mut p = Prueba::new(Some(1), vec![obj(1, TipoObjetivo::Tarea, 5, Some(2))]);
    p.iniciar();
    while !p.act().ends_with("explicar") {
        match p.m.esperando() {
            Esperando::Conversacion { .. } => {
                p.e(Entrada::Texto("sigue".into()));
            }
            _ => {
                p.responder(true);
            }
        }
    }
    let mut pistas = 0;
    for _ in 0..3 {
        let r = p.responder(false);
        pistas += r.iter().filter(|m| m.clase == Clase::Pista).count();
    }
    assert_eq!(pistas, 3, "2 socráticas y 1 gráfica");
    assert!(p.act().ends_with("explicar"));
    p.responder(false);
    assert!(p.registro_tiene("repaso conceptual"));
    p.responder(true);
    assert_eq!(p.act(), "etapa2:2:1");
}

fn llegar_a_e2(nivel_previo: u8) -> Prueba {
    let mut p = Prueba::new(
        Some(nivel_previo),
        vec![obj(1, TipoObjetivo::Tarea, 5, Some(nivel_previo + 1))],
    );
    p.iniciar();
    p.pasar_e1();
    assert!(p.act().starts_with("etapa2"));
    p
}

/// A15: falla el ejercicio 3: 2 socráticas, 1 gráfica, reintenta solo el 3; NIC máx 4/5.
#[test]
fn a15_falla_el_tercero() {
    let mut p = llegar_a_e2(2);
    p.responder(true);
    p.responder(true);
    assert_eq!(p.act(), "etapa2:3:3");
    let mut tipos = vec![];
    for _ in 0..3 {
        let r = p.responder(false);
        tipos.extend(
            r.iter()
                .filter(|m| m.clase == Clase::Pista)
                .map(|m| m.adjunto.is_some()),
        );
        assert_eq!(p.act(), "etapa2:3:3", "reintenta el mismo");
    }
    assert_eq!(
        tipos,
        vec![false, false, true],
        "socrática, socrática, gráfica"
    );
    p.responder(true);
    p.responder(true);
    p.responder(true);
    let nic = &p.m.metricas.nic[0];
    assert_eq!(nic.aciertos(), 4);
    assert_eq!(nic.primer_intento.len(), 5);
}

/// A16: vuelve a fallar tras pistas y paso a paso: Etapa 1 del mismo nivel.
#[test]
fn a16_vuelve_a_etapa1() {
    let mut p = llegar_a_e2(2);
    for _ in 0..4 {
        p.responder(false);
    }
    assert!(p.log.iter().any(|m| matches!(&m.adjunto, Some(aule_core::motor::Adjunto::Pasos { titulo, .. }) if titulo.contains("similar"))));
    p.responder(false);
    assert!(p.registro_tiene("E2-04"));
    assert_eq!(p.act(), "etapa1:3:teoria");
    // E2-05: repetir no impide seguir.
    p.pasar_e1();
    p.pasar_e2();
    assert_eq!(p.act(), "tarea:1");
}

/// A18: simulación con falla: sin pistas, etapas, y se vuelve a simular solo lo fallado con ejercicios nuevos.
#[test]
fn a18_simulacion_con_falla() {
    let mut p = Prueba::new(Some(4), vec![obj(1, TipoObjetivo::Preparacion, 5, Some(4))]);
    p.iniciar();
    assert_eq!(p.act(), "simulacion:1");
    let r = p.e(Entrada::Ayuda);
    assert!(r.iter().all(|m| m.clase != Clase::Pista));
    let mut ids_n3 = vec![];
    let mut i = 0;
    while p.act().starts_with("simulacion") {
        let ej = p.m.ejercicio_actual().unwrap();
        let ok = !(ej.nivel == 3 && i % 2 == 0);
        if ej.nivel == 3 {
            ids_n3.push(ej.id.clone());
        }
        let r = p.responder(ok);
        assert!(r.iter().all(|m| m.clase != Clase::Pista));
        i += 1;
    }
    assert!(p.registro_tiene("PRE-09"));
    assert_eq!(p.act(), "etapa1:3:teoria");
    p.pasar_e1();
    p.pasar_e2();
    assert!(p.act().starts_with("simulacion"));
    let mut n = 0;
    while p.act().starts_with("simulacion") {
        let ej = p.m.ejercicio_actual().unwrap();
        assert_eq!(ej.nivel, 3, "solo lo fallado");
        assert!(!ids_n3.contains(&ej.id), "ejercicios nuevos");
        p.responder(true);
        n += 1;
    }
    assert_eq!(n, 2);
    assert!(p.m.terminada() || p.act() != "siguiente");
}

fn tarea_con_minutos(adelanto: u64) -> Prueba {
    let mut p = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.e(Entrada::Comenzar);
    p.reloj.avanzar_min(adelanto);
    p.e(Entrada::Texto("listo".into()));
    if p.act() == "pausa" {
        p.e(Entrada::SaltarPausa);
    }
    p
}

fn indice_aviso(p: &mut Prueba) -> Option<usize> {
    let mut idx = None;
    for k in 0..5 {
        if p.log.iter().any(|m| m.clase == Clase::Aviso) && idx.is_none() {
            idx = Some(k);
        }
        if !p.act().starts_with("tarea") {
            break;
        }
        p.responder(true);
    }
    idx
}

/// A20: proyección entre 30 y 60 minutos: aviso faltando 2 ejercicios.
#[test]
fn a20_aviso_faltando_2() {
    let mut p = tarea_con_minutos(28);
    let k = indice_aviso(&mut p).expect("hubo aviso");
    assert_eq!(k, 3, "el aviso sale al presentar el 4º de 5 (faltan 2)");
    assert!(texto(&p.log).contains("últimos 2 ejercicios"));
    assert!(p.registro_tiene("SES-05"));
}

/// A21: proyección entre 1 h y 1 h 30: aviso faltando 3.
#[test]
fn a21_aviso_faltando_3() {
    let mut p = tarea_con_minutos(58);
    // En el minuto 58 la pausa del minuto 30 ya se debía: se salta para medir el aviso.
    let k = indice_aviso(&mut p).expect("hubo aviso");
    assert_eq!(k, 2, "faltan 3");
    assert!(texto(&p.log).contains("últimos 3 ejercicios"));
}

/// Sesión corta (≤ 30 min): no se avisa.
#[test]
fn ses05_sin_aviso_en_30_minutos() {
    let mut p = tarea_con_minutos(0);
    assert_eq!(indice_aviso(&mut p), None);
}

/// [PROPUESTA] A quien dijo que está cansado y no elige, se le propone una
/// actividad relajante, la siguiente de ellas en cada pausa; en una pausa por
/// tiempo, la siguiente de la lista, como antes.
#[test]
fn cansado_sin_elegir_se_le_propone_una_actividad_relajante() {
    let mut p = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.iniciar();
    p.e(Entrada::Cansado);
    let r = p.e(Entrada::Texto("no sé, la que sea".into()));
    assert!(texto(&r).contains("Respiración del globo"), "{}", texto(&r));
    assert!(!texto(&r).contains("Saltos de estrella"), "{}", texto(&r));
    p.e(Entrada::SaltarPausa);
    p.e(Entrada::Cansado);
    let r = p.e(Entrada::Texto("la que sea".into()));
    assert!(texto(&r).contains("Estiramiento del gato"), "{}", texto(&r));

    let mut p = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.iniciar();
    p.responder(true);
    p.reloj.avanzar_min(31);
    p.responder(true);
    assert!(p.registro_tiene("PAU-02"));
    let r = p.e(Entrada::Texto("no sé, la que sea".into()));
    assert!(texto(&r).contains("Saltos de estrella"), "{}", texto(&r));
}

/// A22: minuto 30 en medio de un ejercicio: la pausa entra al terminar.
#[test]
fn a22_pausa_al_terminar_el_ejercicio() {
    let mut p = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.iniciar();
    p.responder(true);
    assert_eq!(p.act(), "tarea:2");
    p.reloj.avanzar_min(31);
    p.e(Entrada::Tick);
    assert_eq!(p.act(), "tarea:2", "no interrumpe el ejercicio (PAU-04)");
    p.responder(true);
    assert_eq!(p.act(), "pausa");
    assert!(p.registro_tiene("PAU-02"));
    p.e(Entrada::Actividad(2));
    p.reloj.avanzar_s(300);
    p.e(Entrada::Tick);
    assert_eq!(p.act(), "tarea:3");
}

/// A23: "Estoy cansado" en el minuto 20.
#[test]
fn a23_cansado_en_el_minuto_20() {
    let mut p = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.iniciar();
    p.reloj.avanzar_min(20);
    p.e(Entrada::Cansado);
    assert_eq!(p.act(), "pausa");
    assert!(p.registro_tiene("PAU-05"));
    p.e(Entrada::SaltarPausa);
    assert_eq!(p.act(), "tarea:1", "vuelve al mismo ejercicio");
    // La pausa del minuto 30 ya se tomó (cuenta como la primera).
    p.reloj.avanzar_min(11);
    p.responder(true);
    assert_eq!(p.act(), "tarea:2");
}

/// A24: termina en el minuto 20 sin pendientes ni sugerencia del padre: extracurricular y elige el alumno.
#[test]
fn a24_extracurricular_elige_el_alumno() {
    let mut p = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.iniciar();
    while p.act().starts_with("tarea") {
        p.reloj.avanzar_min(3);
        p.responder(true);
    }
    assert!(p.m.transcurrido_min() < 30.0);
    assert_eq!(p.act(), "elegir_tema");
    assert!(p.registro_tiene("SES-02"));
    assert!(p.registro_tiene("el Alumno elige"));
    p.e(Entrada::Texto("Sí, fracciones".into()));
    assert_eq!(p.act(), "etapa1:4:teoria");
}

/// A25: nivel 5: felicita y sugiere.
#[test]
fn a25_nivel_5_felicita_y_sugiere() {
    let mut p = Prueba::new(Some(5), vec![]);
    p.iniciar();
    assert!(p.registro_tiene("RUT-09"));
    assert_eq!(p.act(), "elegir_tema");
    assert!(texto(&p.log).contains("Felicitaciones"));
    // La sugerencia sale de sus intereses.
    match p.m.esperando() {
        Esperando::Conversacion { sugerencias } => assert!(sugerencias.len() >= 2),
        _ => panic!(),
    }
    p.e(Entrada::Texto("quiero aprender de volcanes".into()));
    p.e(Entrada::Texto("no".into()));
    assert!(p.m.terminada());
    assert!(p.m.informe().iter().any(|m| m.contains("volcanes")));
}

/// D2: adelantar el reloj no interrumpe el ejercicio.
#[test]
fn d2_adelantar_no_interrumpe() {
    let mut p = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.iniciar();
    let id = p.m.ejercicio_actual().unwrap().id;
    p.reloj.avanzar_min(45);
    p.e(Entrada::Tick);
    assert_eq!(p.m.ejercicio_actual().unwrap().id, id);
    assert_eq!(p.act(), "tarea:1");
}

/// D3: informe con un solo saludo (sesión real).
#[test]
fn d3_informe_un_solo_saludo() {
    let mut p = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.iniciar();
    p.reloj.avanzar_min(35);
    while !p.m.terminada() {
        match p.m.esperando() {
            Esperando::Respuesta { .. } | Esperando::Explicacion { .. } => {
                p.responder(true);
            }
            Esperando::Actividad { .. } => {
                p.e(Entrada::SaltarPausa);
            }
            _ => {
                p.e(Entrada::Texto("sí".into()));
            }
        }
    }
    let inf = p.m.informe();
    assert_eq!(inf.iter().filter(|m| m.starts_with("¡Hola")).count(), 1);
    assert!(inf.iter().any(|m| m.contains("hemos hecho la tarea")));
}

/// A5 con el motor: tarea jueves y evaluación viernes → primero la tarea.
#[test]
fn a5_motor_primero_la_tarea() {
    let mut p = Prueba::new(
        Some(3),
        vec![
            obj(1, TipoObjetivo::Preparacion, 6, Some(3)),
            obj(2, TipoObjetivo::Tarea, 5, Some(3)),
        ],
    );
    p.iniciar();
    assert_eq!(p.act(), "tarea:1");
}

/// OBJ-08: tema no cubierto se dice y se registra.
#[test]
fn obj08_no_cubierto() {
    let mut o = obj(1, TipoObjetivo::Tarea, 3, Some(2));
    o.curso = "Ciencia y Tecnología".into();
    o.tema = "Las plantas".into();
    let mut p = Prueba::new(Some(3), vec![o, obj(2, TipoObjetivo::Tarea, 5, Some(3))]);
    p.iniciar();
    assert!(p.registro_tiene("OBJ-08"));
    assert!(texto(&p.log).contains("honesto"));
    assert_eq!(p.act(), "tarea:1");
}

/// OBJ-10: sin fecha se pregunta.
#[test]
fn obj10_pregunta_la_fecha() {
    let mut o = obj(1, TipoObjetivo::Tarea, 0, Some(3));
    o.fecha = None;
    let mut p = Prueba::new(Some(3), vec![o]);
    p.e(Entrada::Comenzar);
    assert_eq!(p.act(), "pedir_fecha");
    p.e(Entrada::Texto("no sé".into()));
    assert_eq!(p.act(), "pedir_fecha");
    p.e(Entrada::Texto("el jueves".into()));
    assert_eq!(p.act(), "bienvenida");
}

/// Corrección: nivel desconocido → tamizaje, luego resolver solo lo fallado.
#[test]
fn correccion_tamizaje_y_falladas() {
    let mut p = Prueba::new(None, vec![obj(1, TipoObjetivo::Correccion, -2, None)]);
    p.iniciar();
    assert!(p.act().starts_with("tamizaje"));
    for _ in 0..5 {
        p.responder(true);
    }
    assert_eq!(p.act(), "correccion:1");
    let r = p.responder(false);
    assert!(
        r.iter().any(|m| m.clase == Clase::Pista),
        "COR-05: con pistas"
    );
}

// ───────────── Simulación de sesiones completas de 1 hora ─────────────

#[derive(Clone, Copy, Debug)]
enum Alumno {
    TodoBien,
    AVeces,
    Mucho,
}

fn correcto(a: Alumno, k: usize) -> bool {
    match a {
        Alumno::TodoBien => true,
        Alumno::AVeces => k % 4 != 1,
        Alumno::Mucho => k % 10 >= 6,
    }
}

fn sesion_completa(objetivos: Vec<Objetivo>, nivel: Option<u8>, a: Alumno, etiqueta: &str) {
    let mut p = Prueba::new(nivel, objetivos);
    p.e(Entrada::Comenzar);
    let mut k = 0usize;
    let mut pasos = 0;
    while !p.m.terminada() {
        pasos += 1;
        assert!(
            pasos < 3000,
            "{etiqueta}: demasiados pasos; actividad {}",
            p.act()
        );
        match p.m.esperando() {
            Esperando::Respuesta { .. } => {
                let s = p.m.ejercicio_actual().map(|e| e.tiempo_s).unwrap_or(40) as u64;
                p.reloj.avanzar_s(s);
                k += 1;
                p.responder(correcto(a, k));
            }
            Esperando::Explicacion { .. } => {
                p.reloj.avanzar_s(60);
                k += 1;
                p.responder(correcto(a, k));
            }
            Esperando::Conversacion { sugerencias } => {
                p.reloj.avanzar_s(25);
                let t = sugerencias.first().cloned().unwrap_or_else(|| "sí".into());
                p.e(Entrada::Texto(t));
            }
            Esperando::Actividad { .. } => {
                p.e(Entrada::Actividad(0));
                p.reloj.avanzar_s(300);
                p.e(Entrada::Tick);
            }
            Esperando::Nada => panic!("{etiqueta}: estado sin salida en {}", p.act()),
        }
        p.e(Entrada::Tick);
    }
    let min = p.m.transcurrido_min();
    if std::env::var("AULE_DEBUG").is_ok() && etiqueta.contains("Tarea Mucho nivel Some(3)") {
        for r in p.m.registro().iter().rev().take(30).rev() {
            eprintln!("  {r}");
        }
    }
    assert!(min <= 100.0, "{etiqueta}: duró {min:.0} min");
    let inf = p.m.informe();
    assert!(inf.len() >= 2, "{etiqueta}: informe vacío {inf:?}");
    assert_eq!(inf.iter().filter(|m| m.starts_with("¡Hola")).count(), 1);
    let cierre_corto = min < 30.0 || p.registro_tiene("RUT-0") || p.registro_tiene("OBJ-11");
    assert!(
        p.m.aviso_dado() || cierre_corto || p.registro_tiene("SES-01"),
        "{etiqueta}: cerró sin aviso a los {min:.0} min"
    );
    eprintln!(
        "{etiqueta:<38} {min:>5.1} min · pausas {} · aviso {} · {} mensajes de informe",
        p.m.pausas_tomadas(),
        p.m.aviso_dado(),
        inf.len()
    );
}

#[test]
fn simulacion_sesiones_completas() {
    for a in [Alumno::TodoBien, Alumno::AVeces, Alumno::Mucho] {
        for nivel in [None, Some(1), Some(3)] {
            sesion_completa(
                vec![obj(1, TipoObjetivo::Tarea, 5, Some(4))],
                nivel,
                a,
                &format!("Tarea {a:?} nivel {nivel:?}"),
            );
            sesion_completa(
                vec![obj(1, TipoObjetivo::Preparacion, 6, Some(4))],
                nivel,
                a,
                &format!("Preparación {a:?} nivel {nivel:?}"),
            );
            sesion_completa(
                vec![obj(1, TipoObjetivo::Correccion, -3, None)],
                nivel,
                a,
                &format!("Corrección {a:?} nivel {nivel:?}"),
            );
            sesion_completa(
                vec![],
                nivel,
                a,
                &format!("Sin tareas {a:?} nivel {nivel:?}"),
            );
        }
    }
}

/// [PROPUESTA] Por voz no hay un botón para volver de la pausa.
#[test]
fn pausa_se_vuelve_diciendolo_y_una_pregunta_no_la_termina() {
    let mut p = Prueba::new(None, vec![obj(1, TipoObjetivo::Tarea, 5, None)]);
    p.iniciar();
    p.e(Entrada::Cansado);
    assert_eq!(p.act(), "pausa");
    // Sin nombrar una actividad, se le propone una: relajante, porque dijo que está cansado.
    let r = p.e(Entrada::Texto("no sé, la que sea".into()));
    assert!(texto(&r).contains("Respiración del globo"), "{}", texto(&r));
    p.reloj.avanzar_s(60);
    let r = p.e(Entrada::Texto("¿cuánto falta?".into()));
    assert_eq!(
        p.act(),
        "pausa",
        "una pregunta no termina la pausa: {}",
        texto(&r)
    );
    p.reloj.avanzar_s(60);
    let r = p.e(Entrada::Texto("ya volví".into()));
    assert_ne!(p.act(), "pausa", "{}", texto(&r));
    assert!(texto(&r).contains("seguimos"), "{}", texto(&r));
}
