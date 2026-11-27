//! Escenarios del motor de aule-core con el banco real.
//! (Viven aquí porque necesitan el contenido, y `contenido` depende de `aule-core`.)

use aule_core::banco::Angulo;
use aule_core::config::Config;
use aule_core::conversacion::Intencion;
use aule_core::informe::Hecho;
use aule_core::modelo::{EstadoObjetivo, Objetivo, Perfil, TipoObjetivo};
use aule_core::motor::{
    Calificacion, Clase, Entrada, Esperando, LecturaTarea, Mensaje, Motor, NO_TENGO_TAREA, SEGUIMOS,
};
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

/// [PROPUESTA] La práctica empieza por la gráfica, el error y el inverso:
/// quien acierta 3 seguidos a la primera también encuentra un error y
/// resuelve un problema inverso antes de terminar la Etapa 2.
#[test]
fn e201_quien_acierta_3_seguidos_tambien_ve_el_error_y_el_inverso() {
    let mut p = llegar_a_e2(2);
    let mut vistos = vec![];
    while p.act().starts_with("etapa2") {
        vistos.push(p.m.ejercicio_actual().and_then(|e| e.angulo));
        p.responder(true);
    }
    assert_eq!(
        vistos,
        [
            Some(Angulo::Grafica),
            Some(Angulo::Error),
            Some(Angulo::Inverso)
        ]
    );
}

/// [PROPUESTA] E2-02: la Etapa 2 termina cuando los últimos 3 ejercicios salen
/// bien al primer intento y sin pistas. Se le dice al Alumno que son hasta 5,
/// MET-01 queda con los que hizo y el Informe dice lo que domina.
#[test]
fn e202_tres_seguidos_a_la_primera_terminan_la_etapa2() {
    let mut p = llegar_a_e2(2);
    assert_eq!(p.act(), "etapa2:3:1");
    let dichas = textos(&p.log);
    assert!(dichas.contains(
        &"Etapa 2: Refuerzo. Ahora te toca a ti: son hasta 5 ejercicios. Si te trabas, pídeme una pista."
    ));
    assert!(dichas.contains(&"Ejercicio 1."), "{}", texto(&p.log));
    // La pantalla sigue mostrando el lugar en la lista del banco.
    assert_eq!(p.m.vista().progreso, "Nivel 3 · Ejercicio 1 de 5");
    p.responder(true);
    p.responder(true);
    assert_eq!(p.act(), "etapa2:3:3");
    let r = p.responder(true);
    assert!(textos(&r).contains(
        &"¡Completaste la Etapa 2! Te salieron 3 seguidos a la primera, así que ya dominas: sumar y restar fracciones con igual denominador y convertir mixtos e impropias."
    ), "{}", texto(&r));
    assert_eq!(p.act(), "tarea:1");
    assert_eq!(p.m.metricas.nic[0].primer_intento, [true, true, true]);
    assert!(p.registro_tiene(
        "Completó 3 ejercicios del nivel 3: los últimos 3 bien al primer intento y sin pistas"
    ));
    assert_eq!(p.m.perfil.niveles["Fracciones"], 3);
    while p.act().starts_with("tarea") {
        p.responder(true);
    }
    assert!(p.m.informe().iter().any(|m| m
        == "Ahora Liam domina sumar y restar fracciones con igual denominador y convertir mixtos e impropias. ¡Felicidades!"));

    // Cuentan los últimos 3: con un error en el primero, termina en el cuarto.
    let mut p = llegar_a_e2(2);
    p.responder(false);
    for _ in 0..3 {
        p.responder(true);
    }
    assert_eq!(p.act(), "etapa2:3:4");
    p.responder(true);
    assert_eq!(p.act(), "tarea:1");
    assert_eq!(
        p.m.metricas.nic[0].primer_intento,
        [false, true, true, true]
    );

    // Una pista también corta la racha: sin 3 seguidos, hasta el máximo de 5.
    let mut p = llegar_a_e2(2);
    p.responder(false);
    p.responder(true);
    p.responder(true);
    p.e(Entrada::Ayuda);
    p.responder(true);
    p.responder(true);
    assert_eq!(p.act(), "etapa2:3:5");
    p.responder(true);
    assert_eq!(p.act(), "tarea:1");
    assert_eq!(
        p.m.metricas.nic[0].primer_intento,
        [false, true, false, true, true]
    );
    assert!(p.registro_tiene("Completó los 5 ejercicios del nivel 3"));

    // Con el ajuste en 0, siempre los 5, y se dice el total.
    let mut p = Prueba::new(Some(2), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.m.cfg.etapa2_aciertos_seguidos = 0;
    p.iniciar();
    p.pasar_e1();
    let dichas = textos(&p.log);
    assert!(dichas.contains(
        &"Etapa 2: Refuerzo. Ahora te toca a ti: son 5 ejercicios. Si te trabas, pídeme una pista."
    ));
    assert!(dichas.contains(&"Ejercicio 1 de 5."));
    for _ in 0..4 {
        p.responder(true);
    }
    assert_eq!(p.act(), "etapa2:3:5");
    p.responder(true);
    assert_eq!(p.act(), "tarea:1");
}

/// Un Alumno con nivel 1 y una Tarea de nivel 2, recién empezada la Etapa 1
/// del nivel 2: lo que el motor dijo al abrirla.
fn en_la_teoria() -> (Prueba, Vec<Mensaje>) {
    let mut p = Prueba::new(Some(1), vec![obj(1, TipoObjetivo::Tarea, 5, Some(2))]);
    p.e(Entrada::Comenzar);
    let r = p.e(Entrada::Texto("¡Listo, empecemos!".into()));
    assert_eq!(p.act(), "etapa1:2:teoria");
    (p, r)
}

fn charla(p: &mut Prueba, texto: &str) -> Vec<Mensaje> {
    p.e(Entrada::Chat {
        texto: texto.into(),
        intencion: Intencion::Charla,
    })
}

const RESPUESTAS_A_SEGUIMOS: [&str; 2] = ["Entendido, sigue", "No entendí"];

/// [PROPUESTA] Por voz no hay un botón «Entendido, sigue»: cada explicación y
/// cada ejemplo resuelto terminan preguntando «¿Seguimos?», y lo que se puede
/// tocar son las dos respuestas que el motor ya sugería ahí. Sin la pregunta el
/// Alumno no sabe que le toca decir que siga (sesiones de voz del 2026-11-26).
#[test]
fn e1_cada_explicacion_y_cada_ejemplo_resuelto_preguntan_si_seguimos() {
    let banco = contenido::cargar_validado().unwrap();
    let e1 = &banco.nivel(2).etapa1;
    let (mut p, mut r) = en_la_teoria();
    let mut vistos = 0;
    while matches!(p.act().as_str(), "etapa1:2:teoria" | "etapa1:2:no_asistido") {
        vistos += 1;
        // Una sola vez, y al final: es lo último que oye.
        assert_eq!(r.last().unwrap().texto, SEGUIMOS, "{}", texto(&r));
        assert_eq!(
            r.iter().filter(|m| m.texto == SEGUIMOS).count(),
            1,
            "{}",
            texto(&r)
        );
        assert_eq!(opciones_de(&p, &r), RESPUESTAS_A_SEGUIMOS);
        r = p.e(Entrada::Texto("Sí".into()));
    }
    assert_eq!(vistos, e1.teoria.len() + e1.no_asistidos.len());
    // El ejemplo acompañado ya trae su propia pregunta: la otra no se añade.
    assert_eq!(p.act(), "etapa1:2:asistido");
    assert!(r.iter().all(|m| m.texto != SEGUIMOS), "{}", texto(&r));
    assert!(p.m.opciones().is_empty());
}

/// [PROPUESTA] Lo que contesta a «¿Seguimos?» lo toma el motor, dicho como
/// salga: «sí», «sigamos» o «seguimos» siguen; «no», «no entendí» u «otra vez»
/// lo explican de nuevo, y se vuelve a preguntar.
#[test]
fn e1_lo_que_se_contesta_a_seguimos_lo_toma_el_motor() {
    let (mut p, inicio) = en_la_teoria();
    let primera = inicio
        .iter()
        .find(|m| m.clase == Clase::Teoria)
        .unwrap()
        .texto
        .clone();
    for dicho in [
        "Sí",
        "sigamos",
        "Seguimos",
        "No",
        "no entendí",
        "otra vez",
        "Entendido, sigue",
    ] {
        assert!(p.m.texto_es_flujo(dicho), "{dicho}");
    }
    // Lo demás es conversación: lo contesta el modelo y no mueve nada.
    for dicho in ["Tres partes de cuatro", "Cuatro", "no sé qué es eso"] {
        assert!(!p.m.texto_es_flujo(dicho), "{dicho}");
    }
    // Quien empieza asintiendo y sigue hablando también avanza (por voz un
    // niño no contesta con una sola palabra): «Ya, entendí. Los pedazos…».
    for dicho in [
        "Ya, entendí. Los pedazos siguen siendo quintos.",
        "Sí, es como partir cada pedazo en dos",
        "Ah, ya, cuatro cuartos hacen un entero",
        "Listo. Dos cuartos es lo mismo que un medio.",
    ] {
        assert!(p.m.texto_es_flujo(dicho), "{dicho}");
    }
    // Salvo que pregunte, objete o no haya asentido de verdad.
    for dicho in [
        "Sí, ¿pero por qué no cambia el de abajo?",
        "Ya, pero no me sale cuando lo hago yo",
        "Sí, no sé por qué se multiplica",
        "Si divido cuatro entre dos me da dos",
        "Ah, cuatro cuartos hacen un entero",
    ] {
        assert!(!p.m.texto_es_flujo(dicho), "{dicho}");
    }

    let r = p.e(Entrada::Texto("No".into()));
    assert_eq!(p.act(), "etapa1:2:teoria");
    assert_eq!(
        r[0].texto,
        format!("Vamos de nuevo, despacito: {primera}"),
        "{}",
        texto(&r)
    );
    assert_eq!(r.last().unwrap().texto, SEGUIMOS);
    assert_eq!(opciones_de(&p, &r), RESPUESTAS_A_SEGUIMOS);

    // «Sigamos» pasa a la explicación siguiente, que ya no es la primera.
    let r = p.e(Entrada::Texto("Sigamos".into()));
    assert!(r.iter().all(|m| m.texto != primera), "{}", texto(&r));
    assert_eq!(r.last().unwrap().texto, SEGUIMOS);

    // Y lo que empieza asintiendo también: no es una pregunta ni un «no entendí».
    let segunda = r
        .iter()
        .find(|m| m.clase == Clase::Teoria)
        .map(|m| m.texto.clone());
    let r = p.e(Entrada::Texto(
        "Ya, entendí. Los pedazos siguen siendo quintos.".into(),
    ));
    assert!(
        r.iter().all(|m| Some(&m.texto) != segunda.as_ref()),
        "{}",
        texto(&r)
    );
    assert!(
        r.iter().all(|m| !m.texto.starts_with("Vamos de nuevo")),
        "{}",
        texto(&r)
    );
}

/// [PROPUESTA] Conversar sobre una explicación no la hace avanzar: un Alumno
/// que contesta otra cosa que «sí» se quedaba ahí toda la sesión (59 turnos
/// sin salir de la teoría, 2026-11-26). A la tercera vez seguida el motor
/// sigue con lo siguiente por su cuenta, como al esperar la foto de la Tarea.
#[test]
fn e1_a_la_tercera_charla_seguida_el_motor_sigue_solo() {
    let (mut p, inicio) = en_la_teoria();
    let primera = inicio
        .iter()
        .find(|m| m.clase == Clase::Teoria)
        .unwrap()
        .texto
        .clone();
    assert_eq!(p.m.cfg.charlas_por_explicacion, 3);

    // Dos veces el motor calla (contesta el modelo) y la explicación sigue ahí.
    assert!(charla(&mut p, "Tres partes de cuatro, ¿no?").is_empty());
    assert!(charla(&mut p, "Cuatro").is_empty());
    assert_eq!(p.act(), "etapa1:2:teoria");
    assert_eq!(p.m.opciones(), RESPUESTAS_A_SEGUIMOS);

    // A la tercera sigue con la explicación siguiente y vuelve a preguntar.
    let r = charla(&mut p, "¿Y si la pizza es cuadrada?");
    assert_eq!(
        r[0].texto,
        "Sigamos, y lo vas a ver en lo que viene.",
        "{}",
        texto(&r)
    );
    assert!(
        r.iter()
            .any(|m| m.clase == Clase::Teoria && m.texto != primera),
        "{}",
        texto(&r)
    );
    assert_eq!(r.last().unwrap().texto, SEGUIMOS);
    assert_eq!(opciones_de(&p, &r), RESPUESTAS_A_SEGUIMOS);
    assert!(p.registro_tiene("3 turnos de conversación sobre la misma explicación"));

    // La cuenta empieza de nuevo con cada explicación: la que trae el motor
    // por su cuenta, la que pide el Alumno con «sí» y la que se repite.
    assert!(charla(&mut p, "uno").is_empty());
    assert!(charla(&mut p, "dos").is_empty());
    p.e(Entrada::Texto("Sí".into()));
    assert!(charla(&mut p, "uno").is_empty());
    assert!(charla(&mut p, "dos").is_empty());
    p.e(Entrada::Texto("No entendí".into()));
    assert!(charla(&mut p, "uno").is_empty());
    assert!(charla(&mut p, "dos").is_empty());
    assert!(!charla(&mut p, "tres").is_empty());

    // Así se sale de la teoría y de los ejemplos resueltos aunque nunca diga «sí».
    let mut turnos = 0;
    while matches!(p.act().as_str(), "etapa1:2:teoria" | "etapa1:2:no_asistido") {
        turnos += 1;
        assert!(turnos < 60, "no sale de la explicación");
        charla(&mut p, "no sé");
    }
    assert_eq!(p.act(), "etapa1:2:asistido");
    // En el ejemplo acompañado la conversación no hace seguir con lo
    // siguiente: ahí hay pistas, y lo que se repite es la pregunta (CHAT-02).
    for _ in 0..5 {
        charla(&mut p, "hola");
    }
    assert_eq!(p.act(), "etapa1:2:asistido");
    assert!(!p.registro_tiene("4 turnos de conversación sobre la misma explicación"));

    // Con el tope en 0 el motor nunca sigue solo.
    let (mut q, _) = en_la_teoria();
    q.m.cfg.charlas_por_explicacion = 0;
    for _ in 0..8 {
        assert!(charla(&mut q, "hola").is_empty());
    }
    assert_eq!(q.act(), "etapa1:2:teoria");
}

/// [PROPUESTA] CHAT-02: con una respuesta pendiente, conversar no la trae, y
/// por voz un número mal oído ni siquiera llega como respuesta. A la tercera
/// vez seguida el motor vuelve a decir su pregunta, tal cual.
#[test]
fn chat02_a_la_tercera_charla_seguida_el_motor_repite_su_pregunta() {
    let mut p = llegar_a_e2(1);
    let ejercicio = p.act();
    let Esperando::Respuesta { enunciado, .. } = p.m.esperando() else {
        panic!("la Etapa 2 espera una respuesta: {:?}", p.m.esperando());
    };
    assert_eq!(p.m.cfg.charlas_por_pregunta, 3);

    // Dos veces el motor calla (contesta el modelo) y el ejercicio sigue ahí.
    assert!(charla(&mut p, "Doce").is_empty());
    assert!(charla(&mut p, "Doce").is_empty());
    // A la tercera dice su pregunta otra vez, y nada más: el ejercicio es el mismo.
    let r = charla(&mut p, "Doce");
    assert_eq!(textos(&r), [enunciado.as_str()], "{}", texto(&r));
    assert_eq!(p.act(), ejercicio);
    assert!(p.registro_tiene("3 turnos de conversación seguidos con una respuesta pendiente"));

    // La cuenta empieza de nuevo.
    assert!(charla(&mut p, "Doce").is_empty());
    assert!(charla(&mut p, "Doce").is_empty());
    // El paso del tiempo no la corta; una ayuda pedida sí, y lo que el motor
    // contesta entonces ya vuelve a dejar la pregunta a la vista.
    assert!(p.e(Entrada::Tick).is_empty());
    assert!(!p.e(Entrada::Ayuda).is_empty());
    assert!(charla(&mut p, "uno").is_empty());
    assert!(charla(&mut p, "dos").is_empty());
    assert!(!charla(&mut p, "tres").is_empty());

    // Con el tope en 0 el motor nunca la repite.
    let mut q = llegar_a_e2(1);
    q.m.cfg.charlas_por_pregunta = 0;
    for _ in 0..8 {
        assert!(charla(&mut q, "Doce").is_empty());
    }
}

/// CHAT-02 vale también para la explicación con sus propias palabras: lo que
/// se repite es la pregunta de la explicación.
#[test]
fn chat02_tambien_repite_la_pregunta_de_la_explicacion() {
    let mut p = Prueba::new(Some(1), vec![obj(1, TipoObjetivo::Tarea, 5, Some(2))]);
    p.iniciar();
    let mut guard = 0;
    let pregunta = loop {
        guard += 1;
        assert!(guard < 100, "la Etapa 1 no llega a pedir la explicación");
        match p.m.esperando() {
            Esperando::Explicacion { pregunta, .. } => break pregunta,
            Esperando::Conversacion { .. } => {
                p.e(Entrada::Texto("Entendido, sigue".into()));
            }
            Esperando::Respuesta { .. } => {
                p.responder(true);
            }
            otro => panic!("estado inesperado en E1: {otro:?}"),
        }
    };
    let paso = p.act();

    assert!(charla(&mut p, "hola").is_empty());
    assert!(charla(&mut p, "¿y tú cómo te llamas?").is_empty());
    let r = charla(&mut p, "ya");
    assert_eq!(textos(&r), [pregunta.as_str()], "{}", texto(&r));
    assert_eq!(p.act(), paso);
}

/// Por voz, la respuesta a un paso con opciones en cifras llega en palabras.
/// En el ejemplo acompañado del nivel 2, «¿Cuál de las fracciones originales
/// es mayor?» tiene las opciones «2/3» y «5/6»: «cinco sextos» la contesta
/// (2026-11-26: dicha quince veces seguidas, nunca se corrigió).
#[test]
fn las_opciones_en_cifras_del_banco_se_contestan_en_palabras() {
    use aule_core::correccion::{corregir, Clave, Veredicto};
    let mut p = Prueba::new(Some(1), vec![obj(1, TipoObjetivo::Tarea, 5, Some(2))]);
    p.iniciar();
    while p.act() != "etapa1:2:asistido" {
        assert!(p.act().starts_with("etapa1:2"), "{}", p.act());
        p.e(Entrada::Texto("Entendido, sigue".into()));
    }
    // Con un error en el primer ejemplo guiado, el segundo sigue (E1-03): es
    // el que compara 2/3 y 5/6.
    for ok in [true, false, true, true] {
        p.responder(ok);
    }
    let mut guard = 0;
    let (respuesta, opciones, forma) = loop {
        guard += 1;
        assert!(
            guard < 10,
            "el segundo ejemplo guiado no llega a su paso con opciones"
        );
        match p.m.esperando() {
            Esperando::Respuesta {
                respuesta,
                opciones,
                forma,
                ..
            } if opciones.iter().any(|o| o.contains('/')) => break (respuesta, opciones, forma),
            Esperando::Respuesta { .. } => {
                p.responder(true);
            }
            otro => panic!("el ejemplo guiado espera una respuesta: {otro:?}"),
        }
    };
    assert_eq!(respuesta, "5/6");
    assert_eq!(opciones, ["2/3", "5/6"]);
    let clave = Clave {
        respuesta: &respuesta,
        opciones: &opciones,
        forma,
    };
    assert_eq!(
        corregir(&clave, "Cinco sextos").veredicto,
        Veredicto::Correcta
    );
    assert_eq!(
        corregir(&clave, "dos tercios").veredicto,
        Veredicto::Incorrecta
    );
    assert_eq!(corregir(&clave, "Doce").veredicto, Veredicto::Ilegible);
}

/// [PROPUESTA] E1-03: si los pasos del primer ejemplo guiado salen bien al
/// primer intento y sin pistas, se pasa a explicarlo sin el segundo ejemplo.
/// Con un error o una pista, el segundo ejemplo sigue.
#[test]
fn e103_un_ejemplo_guiado_limpio_lleva_a_explicar() {
    let hasta_el_guiado = || {
        let mut p = Prueba::new(Some(1), vec![obj(1, TipoObjetivo::Tarea, 5, Some(2))]);
        p.iniciar();
        while p.act() != "etapa1:2:asistido" {
            assert!(p.act().starts_with("etapa1:2"), "{}", p.act());
            p.e(Entrada::Texto("Entendido, sigue".into()));
        }
        p
    };
    let guiados = |p: &Prueba| {
        p.log
            .iter()
            .filter(|m| m.texto.starts_with("Te acompaño paso a paso."))
            .count()
    };

    let mut p = hasta_el_guiado();
    for _ in 0..3 {
        assert_eq!(p.act(), "etapa1:2:asistido");
        p.responder(true);
    }
    assert_eq!(p.act(), "etapa1:2:explicar");
    assert_eq!(guiados(&p), 1, "{}", texto(&p.log));
    assert!(p.registro_tiene("Ejemplo guiado 1 sin errores ni pistas"));
    p.responder(true);
    assert_eq!(p.act(), "etapa2:2:1");

    // Un paso con error: el segundo ejemplo sigue.
    let mut p = hasta_el_guiado();
    for ok in [true, false, true, true] {
        p.responder(ok);
    }
    assert_eq!(p.act(), "etapa1:2:asistido");
    assert_eq!(guiados(&p), 2);
    let titulo = p.m.vista().tarjeta.unwrap().titulo;
    assert!(titulo.contains("Ejemplo guiado 2 de 2"), "{titulo}");

    // Una pista: también.
    let mut p = hasta_el_guiado();
    p.e(Entrada::Ayuda);
    for _ in 0..3 {
        p.responder(true);
    }
    assert_eq!(p.act(), "etapa1:2:asistido");
    assert_eq!(guiados(&p), 2);
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

/// [PROPUESTA] PAU-07: de noche, quien dice que está cansado descansa. La
/// sesión se cierra con su despedida y no se le propone moverse.
#[test]
fn pau07_de_noche_quien_esta_cansado_descansa() {
    let mut p = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.m.perfil.minuto_inicio = Some(22 * 60 + 50);
    p.iniciar();
    let r = p.e(Entrada::Cansado);
    let dicho = texto(&r);
    assert!(
        dicho.contains("Ya es tarde, y lo mejor ahora es descansar"),
        "{dicho}"
    );
    assert!(
        !dicho.contains("Pausa activa") && !dicho.contains("Saltos de estrella"),
        "{dicho}"
    );
    assert_eq!(p.act(), "terminada");
    assert!(p.registro_tiene("PAU-07"));

    // De día, el mismo cansancio trae la pausa.
    let mut p = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.m.perfil.minuto_inicio = Some(16 * 60);
    p.iniciar();
    p.e(Entrada::Cansado);
    assert_eq!(p.act(), "pausa");

    // La noche también llega durante la sesión: empezó a las 20:40 y van 25 minutos.
    let mut p = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    p.m.perfil.minuto_inicio = Some(20 * 60 + 40);
    p.iniciar();
    p.reloj.avanzar_min(25);
    p.e(Entrada::Cansado);
    assert_eq!(p.act(), "terminada");
}

/// [PROPUESTA] Cada actividad de la pausa trae consigo sus palabras y su tipo:
/// la lista se puede reordenar o cambiar en la configuración sin tocar el motor.
#[test]
fn pau06_las_actividades_se_eligen_por_sus_palabras_esten_donde_esten() {
    let mut p = Prueba::new(None, vec![obj(1, TipoObjetivo::Tarea, 5, None)]);
    p.m.cfg.actividades_pausa.reverse();
    p.iniciar();
    p.e(Entrada::Cansado);
    assert_eq!(p.act(), "pausa");
    // «globo» elige la respiración aunque ya no sea la tercera de la lista.
    let r = p.e(Entrada::Texto("la del globo".into()));
    assert!(texto(&r).contains("Respiración del globo"), "{}", texto(&r));

    // A quien está cansado y no elige se le propone la primera relajante de la
    // lista como esté: ahora, el estiramiento.
    let mut p = Prueba::new(None, vec![obj(1, TipoObjetivo::Tarea, 5, None)]);
    p.m.cfg.actividades_pausa.reverse();
    p.iniciar();
    p.e(Entrada::Cansado);
    let r = p.e(Entrada::Texto("no sé, la que sea".into()));
    assert!(texto(&r).contains("Estiramiento del gato"), "{}", texto(&r));
}

/// [PROPUESTA] Tener sueño no elige los saltos de estrella: a quien no elige
/// se le propone una actividad tranquila.
#[test]
fn tener_sueno_no_elige_los_saltos_de_estrella() {
    let mut p = Prueba::new(None, vec![obj(1, TipoObjetivo::Tarea, 5, None)]);
    p.iniciar();
    p.e(Entrada::Cansado);
    assert_eq!(p.act(), "pausa");
    let r = p.e(Entrada::Texto("tengo sueño".into()));
    let dicho = texto(&r);
    assert!(!dicho.contains("Saltos de estrella"), "{dicho}");
    assert!(dicho.contains("Respiración del globo"), "{dicho}");
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
    sesion_con_foto(objetivos, nivel, a, etiqueta, None);
}

/// Con `foto`, el ajuste `foto_tarea` encendido y cada foto de la Tarea leída así.
fn sesion_con_foto(
    objetivos: Vec<Objetivo>,
    nivel: Option<u8>,
    a: Alumno,
    etiqueta: &str,
    foto: Option<LecturaTarea>,
) {
    let mut p = Prueba::new(nivel, objetivos);
    p.m.cfg.foto_tarea = foto.is_some();
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
            Esperando::FotoTarea => {
                p.reloj.avanzar_s(25);
                match foto {
                    Some(lectura) => p.e(Entrada::FotoTarea(lectura)),
                    None => p.e(Entrada::Texto("no tengo".into())),
                };
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

// ───────────── La foto de la Tarea (TAR-05 a TAR-07) ─────────────

const PIDE_FOTO: &str = "Ahora quiero ver tu tarea, para saber qué practicar. Muéstramela a la cámara, y si no la tienes, dime «no tengo».";
const PIDE_FOTO_ANTES: &str = "Antes de empezar, quiero ver tu tarea para saber qué practicar. Muéstramela a la cámara, y si no la tienes, dime «no tengo».";
const RECUERDA_FOTO: &str = "Te escucho. Cuando la tengas, muéstrame tu tarea a la cámara; si no la tienes, dime «no tengo».";
const SIGUE_SIN_FOTO: &str = "No te preocupes, seguimos sin la foto.";
const SIN_FOTO: &str =
    "Vamos a practicar con ejercicios míos, como los de una tarea de fracciones.";
/// El plan de quien está en el nivel 2 hasta el nivel 4 de la Tarea del banco.
const PLAN_DEL_2_AL_4: &str = "He analizado cómo te fue en los ejercicios, y antes de que hagamos la tarea, te voy a ayudar a reforzar las sumas y restas con el mismo denominador y las sumas y restas con distinto denominador. Esto es importante para que aprendas a hacer la tarea por tu cuenta.";

/// [PROPUESTA] Una Tarea sin Nivel objetivo, como la que carga la plataforma,
/// con el ajuste que pide verla en una foto.
fn con_foto(nivel: Option<u8>) -> Prueba {
    let mut p = Prueba::new(nivel, vec![obj(1, TipoObjetivo::Tarea, 5, None)]);
    p.m.cfg.foto_tarea = true;
    p
}

fn leida(nivel: u8, confianza: u8) -> Entrada {
    Entrada::FotoTarea(LecturaTarea::Leida { nivel, confianza })
}

/// [PROPUESTA] TAR-05: tras el calentamiento se ve la Tarea, y recién con su
/// nivel se cuenta y se registra el plan, hasta ese nivel.
#[test]
fn tar05_tras_el_calentamiento_se_ve_la_tarea_y_luego_se_cuenta_el_plan() {
    let mut p = con_foto(None);
    p.iniciar();
    let r = hacer_tamizaje(&mut p, [true, false, false, false, false]);
    assert_eq!(p.m.perfil.niveles["Fracciones"], 1);
    assert_eq!(
        textos(&r),
        [
            "¡Gracias! Esa era la última pregunta del Tamizaje.",
            "¡Terminamos el calentamiento! Gracias por pensar conmigo.",
            PIDE_FOTO,
        ]
    );
    assert_eq!(p.act(), "pedir_tarea");
    assert!(matches!(p.m.esperando(), Esperando::FotoTarea));
    assert_eq!(p.m.recordatorio().as_deref(), Some(PIDE_FOTO));
    assert!(!p
        .m
        .hechos
        .iter()
        .any(|h| matches!(h, Hecho::Tamizaje { .. })));

    let r = p.e(leida(3, 82));
    assert_eq!(
        textos(&r)[..3],
        [
            "¡Gracias! Ya vi tu tarea: es de las sumas y restas con el mismo denominador.",
            "He analizado cómo te fue en los ejercicios, y antes de que hagamos la tarea, te voy a ayudar a reforzar las fracciones equivalentes y las sumas y restas con el mismo denominador. Esto es importante para que aprendas a hacer la tarea por tu cuenta.",
            "Etapa 1: Descubrimiento. Empecemos por las fracciones equivalentes.",
        ]
    );
    assert_eq!(p.act(), "etapa1:2:teoria");
    assert_eq!(p.m.objetivos[0].nivel_objetivo, Some(3));
    assert_eq!(p.m.recordatorio(), None);
    assert!(p.registro_tiene("TAR-05"));
    // El Informe: la Tarea que se vio, y el plan hasta su nivel (no hasta el 4 del banco), una vez.
    let inf = p.m.informe();
    assert!(inf.contains(&"Liam nos mostró su tarea de Matemáticas: es sobre sumar y restar fracciones con igual denominador y convertir mixtos e impropias.".to_string()), "{inf:?}");
    assert!(inf.contains(&"El día de hoy hemos evaluado cómo le va en Matemáticas, y hemos encontrado una oportunidad de mejora específicamente en fracciones equivalentes, simplificar y comparar y sumar y restar fracciones con igual denominador y convertir mixtos e impropias.".to_string()), "{inf:?}");
    assert_eq!(
        inf.iter().filter(|m| m.contains("hemos evaluado")).count(),
        1
    );
    // La ruta llega hasta el nivel de la foto, y luego la Tarea.
    for _ in 0..2 {
        p.pasar_e1();
        p.pasar_e2();
    }
    assert_eq!(p.act(), "tarea:1");

    // Sin el ajuste, como siempre: el plan hasta el nivel de la Tarea del banco, sin foto.
    let mut p = Prueba::new(None, vec![obj(1, TipoObjetivo::Tarea, 5, None)]);
    p.iniciar();
    let r = hacer_tamizaje(&mut p, [true, false, false, false, false]);
    assert!(texto(&r).contains("te voy a ayudar a reforzar las fracciones equivalentes, las sumas y restas con el mismo denominador y las sumas y restas con distinto denominador."), "{}", texto(&r));
    assert!(!texto(&p.log).contains("a la cámara"), "{}", texto(&p.log));
}

/// [PROPUESTA] TAR-05: con el nivel ya conocido se pide antes de empezar; sin
/// nada que reforzar, directo a la Tarea.
#[test]
fn tar05_con_el_nivel_ya_conocido_se_pide_antes_de_empezar() {
    let mut p = con_foto(Some(4));
    p.iniciar();
    assert_eq!(p.act(), "pedir_tarea");
    assert_eq!(p.log.last().unwrap().texto, PIDE_FOTO_ANTES);
    assert_eq!(p.m.recordatorio().as_deref(), Some(PIDE_FOTO_ANTES));
    let r = p.e(leida(4, 90));
    assert_eq!(
        textos(&r)[..2],
        [
            "¡Gracias! Ya vi tu tarea: es de las sumas y restas con distinto denominador.",
            "¡Eso ya lo sabes hacer! Vamos directo a tu tarea.",
        ]
    );
    assert_eq!(p.act(), "tarea:1");
    // Hoy no hubo Tamizaje: el Informe dice que se vio la Tarea, y nada de un Tamizaje.
    let inf = p.m.informe();
    assert!(inf.iter().any(|m| m.contains("nos mostró su tarea")));
    assert!(!inf.iter().any(|m| m.contains("hemos evaluado")), "{inf:?}");

    // Quien presenta ya cargó el Nivel objetivo (OBJ-06): no se pide la foto.
    let mut p = Prueba::new(Some(4), vec![obj(1, TipoObjetivo::Tarea, 5, Some(4))]);
    p.m.cfg.foto_tarea = true;
    p.iniciar();
    assert_eq!(p.act(), "tarea:1");
}

/// [PROPUESTA] TAR-06: una foto que no se lee se pide otra vez, con lo que
/// pasó; a la segunda se sigue sin ella, con la Tarea del banco.
#[test]
fn tar06_una_foto_que_no_se_lee_se_pide_otra_vez_y_a_la_segunda_se_sigue_sin_ella() {
    let borrosa = "Uy, no la pude ver bien. Acércala un poquito a la cámara, con buena luz, y muéstramela otra vez.";
    let no_disponible = "Uy, no pude mirar la foto. ¿Probamos otra vez?";
    for (lectura, linea) in [
        (LecturaTarea::Borrosa, borrosa),
        // Una lectura poco segura es una foto que no se vio bien.
        (
            LecturaTarea::Leida {
                nivel: 3,
                confianza: 69,
            },
            borrosa,
        ),
        (
            LecturaTarea::SinTarea,
            "Mmm, no veo una tarea en la foto. ¿Me la muestras otra vez? Si no la tienes, dime «no tengo».",
        ),
        (LecturaTarea::NoDisponible, no_disponible),
        // Un nivel que el tema no tiene es una lectura que falló.
        (
            LecturaTarea::Leida {
                nivel: 6,
                confianza: 95,
            },
            no_disponible,
        ),
        (
            LecturaTarea::Leida {
                nivel: 0,
                confianza: 95,
            },
            no_disponible,
        ),
    ] {
        let mut p = con_foto(Some(2));
        p.iniciar();
        let r = p.e(Entrada::FotoTarea(lectura));
        assert_eq!(textos(&r), [linea], "{lectura:?}");
        assert_eq!(p.act(), "pedir_tarea");
        let r = p.e(Entrada::FotoTarea(LecturaTarea::NoDisponible));
        assert_eq!(
            textos(&r)[..3],
            [SIGUE_SIN_FOTO, SIN_FOTO, PLAN_DEL_2_AL_4],
            "{lectura:?}"
        );
        assert_eq!(p.act(), "etapa1:3:teoria");
        assert_eq!(p.m.objetivos[0].nivel_objetivo, None);
        assert!(p.registro_tiene("TAR-06") && p.registro_tiene("TAR-07"));
    }
    // Con la confianza justo en el mínimo, se lee.
    let mut p = con_foto(Some(2));
    p.iniciar();
    p.e(leida(3, 70));
    assert_eq!(p.m.objetivos[0].nivel_objetivo, Some(3));
}

/// [PROPUESTA] TAR-06: «no tengo» sigue sin la foto; otra cosa recibe un
/// recordatorio de la cámara, y al tercer turno sin foto se sigue sin ella.
#[test]
fn tar06_no_tengo_o_tres_turnos_sin_foto_siguen_sin_ella() {
    for dicho in [
        "no tengo",
        "No la traje, se me olvidó",
        "no",
        "no quiero",
        "hoy no me dejaron tarea",
    ] {
        let mut p = con_foto(Some(2));
        p.iniciar();
        let r = p.e(Entrada::Texto(dicho.into()));
        assert_eq!(
            textos(&r)[..3],
            ["¡No pasa nada!", SIN_FOTO, PLAN_DEL_2_AL_4],
            "{dicho}"
        );
        assert_eq!(p.act(), "etapa1:3:teoria", "{dicho}");
    }
    let mut p = con_foto(Some(2));
    p.iniciar();
    for dicho in ["no, espera, ya la busco", "¿dónde la dejé?"] {
        let r = p.e(Entrada::Texto(dicho.into()));
        assert_eq!(textos(&r), [RECUERDA_FOTO], "{dicho}");
        assert_eq!(p.act(), "pedir_tarea");
    }
    let r = p.e(Entrada::Texto("mi perro se llama Rocky".into()));
    assert_eq!(textos(&r)[..3], [SIGUE_SIN_FOTO, SIN_FOTO, PLAN_DEL_2_AL_4]);
    assert_eq!(p.act(), "etapa1:3:teoria");
}

/// [PROPUESTA] TAR-07: una Tarea que no es de fracciones se le cuenta a la
/// familia (OBJ-08) y se practica con la Tarea del banco.
#[test]
fn tar07_una_tarea_de_otro_tema_se_le_cuenta_a_la_familia() {
    let mut p = con_foto(Some(2));
    p.iniciar();
    let r = p.e(Entrada::FotoTarea(LecturaTarea::OtroTema));
    assert_eq!(
        textos(&r)[..3],
        [
            "Esa tarea no es de fracciones, y por ahora yo solo sé enseñar fracciones. Se lo cuento a tu familia.",
            SIN_FOTO,
            PLAN_DEL_2_AL_4,
        ]
    );
    assert_eq!(p.act(), "etapa1:3:teoria");
    assert_eq!(p.m.objetivos[0].nivel_objetivo, None);
    assert!(p.m.informe().contains(&"Liam nos mostró una tarea que no es del tema de Fracciones. Todavía no cubrimos ese tema, así que no la trabajamos hoy; te recomendamos revisarla con su Docente.".to_string()));
}

/// [PROPUESTA] TAR-05: al volver de una pausa se pide otra vez; una foto que
/// nadie pidió no cambia nada.
#[test]
fn tar05_tras_una_pausa_se_pide_otra_vez_y_una_foto_sin_pedir_no_cambia_nada() {
    let mut p = con_foto(None);
    p.iniciar();
    hacer_tamizaje(&mut p, [true, true, false, false, false]);
    assert_eq!(p.act(), "pedir_tarea");
    p.e(Entrada::Cansado);
    assert_eq!(p.act(), "pausa");
    assert!(p.e(leida(3, 90)).is_empty());
    assert_eq!(p.act(), "pausa");
    let r = p.e(Entrada::SaltarPausa);
    assert_eq!(textos(&r), ["¡Listo, seguimos!", PIDE_FOTO]);
    assert_eq!(p.act(), "pedir_tarea");

    let mut p = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, None)]);
    p.iniciar();
    let antes = p.act();
    assert!(p.e(leida(1, 99)).is_empty());
    assert_eq!(p.act(), antes);
    assert_eq!(p.m.recordatorio(), None);
}

/// [PROPUESTA] TAM-08: el Tamizaje llega al Informe aunque la sesión se corte
/// mientras se espera la foto, o se cierre por tiempo antes de pedirla.
#[test]
fn tam08_el_tamizaje_llega_al_informe_aunque_no_se_vea_la_tarea() {
    let mut p = con_foto(None);
    p.iniciar();
    hacer_tamizaje(&mut p, [true, false, false, false, false]);
    assert_eq!(p.act(), "pedir_tarea");
    // La plataforma cierra la sesión sin pasar por el motor.
    let inf = p.m.informe();
    assert!(inf.contains(&"El día de hoy hemos evaluado cómo le va en Matemáticas, y hemos encontrado una oportunidad de mejora específicamente en fracciones equivalentes, simplificar y comparar, sumar y restar fracciones con igual denominador y convertir mixtos e impropias y sumar y restar fracciones con distinto denominador.".to_string()), "{inf:?}");

    // Se acaba el tiempo con la última pregunta: se cierra sin pedir la foto,
    // y el Tamizaje va antes de lo que queda pendiente.
    let mut p = con_foto(None);
    p.iniciar();
    for ok in [true, false, false, false] {
        p.responder(ok);
    }
    p.reloj.avanzar_min(91);
    p.responder(false);
    assert!(p.m.terminada());
    assert!(!texto(&p.log).contains("a la cámara"), "{}", texto(&p.log));
    let inf = p.m.informe();
    let evaluado = inf.iter().position(|m| m.contains("hemos evaluado"));
    let continua = inf.iter().position(|m| m.contains("hemos avanzado"));
    assert!(evaluado.is_some() && evaluado < continua, "{inf:?}");
    assert_eq!(
        inf.iter().filter(|m| m.contains("hemos evaluado")).count(),
        1
    );
}

/// [PROPUESTA] Sesiones completas con la foto de la Tarea: cada nivel que se
/// puede leer, otro tema y dos fotos fallidas. Todas terminan, a tiempo y
/// con su Informe.
#[test]
fn tar05_sesiones_completas_con_la_foto_de_la_tarea() {
    let mut fotos: Vec<LecturaTarea> = (1..=5)
        .map(|nivel| LecturaTarea::Leida {
            nivel,
            confianza: 90,
        })
        .collect();
    fotos.extend([LecturaTarea::OtroTema, LecturaTarea::SinTarea]);
    for a in [Alumno::TodoBien, Alumno::AVeces, Alumno::Mucho] {
        for nivel in [None, Some(1), Some(3)] {
            for foto in &fotos {
                sesion_con_foto(
                    vec![obj(1, TipoObjetivo::Tarea, 5, None)],
                    nivel,
                    a,
                    &format!("Foto {foto:?} {a:?} nivel {nivel:?}"),
                    Some(*foto),
                );
            }
        }
    }
}

/// [PROPUESTA] TAR-08: con el nivel de la foto, la Tarea del banco queda en
/// sus ejercicios de ese nivel o menos, y la ruta dice cuántos son.
#[test]
fn tar08_la_tarea_del_banco_llega_hasta_el_nivel_de_la_foto() {
    let tarea = |p: &Prueba| {
        p.m.ruta()
            .into_iter()
            .find(|paso| paso.nombre == "Tarea")
            .map(|paso| paso.detalle)
    };
    // Sin la foto, la del banco entera.
    let mut p = con_foto(Some(2));
    assert_eq!(tarea(&p), Some("5 ejercicios".to_string()));
    p.iniciar();
    p.e(leida(3, 90));
    assert_eq!(p.act(), "etapa1:3:teoria");
    assert_eq!(tarea(&p), Some("2 ejercicios".to_string()));
    p.pasar_e1();
    p.pasar_e2();
    let r = textos(&p.log).join("\n");
    assert!(
        r.contains("Ahora hagamos tu Tarea: son 2 ejercicios."),
        "{r}"
    );
    let mut niveles = vec![];
    while p.act().starts_with("tarea") {
        niveles.push(p.m.ejercicio_actual().unwrap().nivel);
        p.responder(true);
    }
    assert_eq!(niveles, [3, 3]);
    assert!(p
        .m
        .informe()
        .iter()
        .any(|m| m.contains("hemos hecho la tarea de Matemáticas")));

    // Ya tiene el nivel: directo a esos ejercicios.
    let mut p = con_foto(Some(3));
    p.iniciar();
    let r = p.e(leida(3, 90));
    assert_eq!(
        textos(&r)[..3],
        [
            "¡Gracias! Ya vi tu tarea: es de las sumas y restas con el mismo denominador.",
            "¡Eso ya lo sabes hacer! Vamos directo a tu tarea.",
            "¡Ya tienes el nivel! Ahora hagamos tu Tarea: son 2 ejercicios. Hazlos tú solo; yo reviso cada respuesta y te ayudo si te trabas.",
        ]
    );
}

/// [PROPUESTA] TAR-08: si la Tarea del banco no tiene ejercicios hasta el nivel
/// de la foto, lo que pide la Tarea ya se practicó: se dice, va al Informe y
/// el objetivo se cumple.
#[test]
fn tar08_sin_ejercicios_hasta_ese_nivel_la_tarea_ya_esta_preparada() {
    let preparada =
        "¡Listo! Ya practicaste lo que pide tu tarea, así que ahora la puedes hacer por tu cuenta.";
    let informe = "Liam ya domina lo que pide su tarea de Matemáticas para el día jueves 19 de noviembre: fracciones equivalentes, simplificar y comparar. Ya la puede hacer por su cuenta. ¡Felicidades!";
    // Primero se refuerza su nivel; luego no queda nada de la Tarea del banco.
    let mut p = con_foto(Some(1));
    p.iniciar();
    p.e(leida(2, 90));
    assert_eq!(p.act(), "etapa1:2:teoria");
    assert_eq!(
        p.m.ruta()
            .iter()
            .filter(|paso| paso.nombre == "Tarea")
            .count(),
        0
    );
    p.pasar_e1();
    p.pasar_e2();
    assert!(textos(&p.log).contains(&preparada), "{}", texto(&p.log));
    assert!(!p.act().starts_with("tarea"), "{}", p.act());
    assert_eq!(p.m.objetivos[0].estado, EstadoObjetivo::Completado);
    assert!(p.registro_tiene("TAR-08"));
    assert!(
        p.m.informe().contains(&informe.to_string()),
        "{:?}",
        p.m.informe()
    );

    // Ya lo sabe: no se le dice que va directo a una Tarea que no hay.
    let mut p = con_foto(Some(3));
    p.iniciar();
    let r = p.e(leida(2, 90));
    assert_eq!(
        textos(&r)[..2],
        [
            "¡Gracias! Ya vi tu tarea: es de las fracciones equivalentes.",
            preparada
        ]
    );
    assert!(!texto(&r).contains("Vamos directo"), "{}", texto(&r));
    assert!(p.m.informe().contains(&informe.to_string()));
}

/// [PROPUESTA] PAU-07 y TAM-08: de noche, quien dice que está cansado
/// mientras se espera la foto de su Tarea descansa, y el Informe cuenta el
/// Tamizaje antes de lo que queda pendiente.
#[test]
fn pau07_de_noche_cansado_esperando_la_foto_descansa_y_el_informe_cuenta_el_tamizaje() {
    let mut p = con_foto(None);
    p.m.perfil.minuto_inicio = Some(22 * 60 + 50);
    p.iniciar();
    hacer_tamizaje(&mut p, [true, false, false, false, false]);
    assert_eq!(p.act(), "pedir_tarea");
    let r = p.e(Entrada::Cansado);
    assert!(texto(&r).contains("Ya es tarde"), "{}", texto(&r));
    assert!(p.m.terminada());
    assert_eq!(p.m.recordatorio(), None);
    let inf = p.m.informe();
    let evaluado = inf.iter().position(|m| m.contains("hemos evaluado"));
    let continua = inf.iter().position(|m| m.contains("hemos avanzado"));
    assert!(evaluado.is_some() && evaluado < continua, "{inf:?}");
    assert_eq!(
        inf.iter().filter(|m| m.contains("hemos evaluado")).count(),
        1
    );
}

// ───────────── Lo que se puede tocar en la pantalla ─────────────

/// Las opciones de cada mensaje de una respuesta del motor: solo el último
/// puede tenerlas, y son las que el motor ofrece ahora.
fn opciones_de(p: &Prueba, r: &[Mensaje]) -> Vec<String> {
    let (ultimo, antes) = r.split_last().expect("el motor contestó algo");
    assert!(
        antes.iter().all(|m| m.opciones.is_empty()),
        "solo el último mensaje ofrece algo: {}",
        texto(r)
    );
    assert_eq!(ultimo.opciones, p.m.opciones());
    ultimo.opciones.clone()
}

/// [PROPUESTA] A «¿Empezamos?» se toca «Sí», que empieza como decirlo. No hay
/// un «No»: cualquier respuesta empieza.
#[test]
fn opciones_a_empezamos_se_toca_si() {
    let mut p = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
    let r = p.e(Entrada::Comenzar);
    assert!(
        r.last().unwrap().texto.ends_with("¿Empezamos?"),
        "{}",
        texto(&r)
    );
    assert_eq!(opciones_de(&p, &r), ["Sí"]);
    let r = p.e(Entrada::Texto("Sí".into()));
    assert_eq!(p.act(), "tarea:1");
    assert!(r.iter().all(|m| m.opciones.is_empty()), "{}", texto(&r));
}

/// [PROPUESTA] PAU-06: la Pausa activa ofrece sus cuatro actividades, y tocar
/// una es elegirla, igual que `Entrada::Actividad`. Elegida, no se ofrecen más.
#[test]
fn opciones_la_pausa_ofrece_sus_actividades_y_tocar_una_la_elige() {
    let nombres: Vec<String> = Config::default()
        .actividades_pausa
        .iter()
        .map(|a| a.nombre.clone())
        .collect();
    for (k, nombre) in nombres.iter().enumerate() {
        let mut tocada = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
        tocada.iniciar();
        let r = tocada.e(Entrada::Cansado);
        // La línea las nombra todas: por voz no se ve la tabla.
        assert!(
            r.last().unwrap().texto.ends_with(&format!(
                "Elige una: {}.",
                aule_core::informe::lista_o(&nombres)
            )),
            "{}",
            texto(&r)
        );
        assert_eq!(opciones_de(&tocada, &r), nombres);
        let dicho = tocada.e(Entrada::Texto(nombre.clone()));

        let mut elegida = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
        elegida.iniciar();
        elegida.e(Entrada::Cansado);
        let elegido = elegida.e(Entrada::Actividad(k));
        assert_eq!(textos(&dicho), textos(&elegido), "{nombre}");
        assert_eq!(
            tocada.m.vista().pausa.unwrap().actividad.unwrap().nombre,
            *nombre
        );
        assert!(tocada.m.opciones().is_empty());
        let r = tocada.e(Entrada::Texto("¿cuánto falta?".into()));
        assert!(r.iter().all(|m| m.opciones.is_empty()), "{}", texto(&r));
    }
}

/// [PROPUESTA] TAR-06: cada vez que se pide la foto de la Tarea se puede tocar
/// «No tengo mi tarea», que sigue sin ella como decir «no tengo».
#[test]
fn opciones_al_pedir_la_foto_se_toca_no_tengo_mi_tarea() {
    let mut p = con_foto(Some(4));
    p.iniciar();
    assert_eq!(p.log.last().unwrap().texto, PIDE_FOTO_ANTES);
    assert_eq!(p.log.last().unwrap().opciones, [NO_TENGO_TAREA]);
    let r = p.e(Entrada::Texto("espera".into()));
    assert_eq!(textos(&r), [RECUERDA_FOTO]);
    assert_eq!(opciones_de(&p, &r), [NO_TENGO_TAREA]);
    let r = p.e(Entrada::FotoTarea(LecturaTarea::NoDisponible));
    assert_eq!(
        textos(&r),
        ["Uy, no pude mirar la foto. ¿Probamos otra vez?"]
    );
    assert_eq!(opciones_de(&p, &r), [NO_TENGO_TAREA]);
    let tocado = p.e(Entrada::Texto(NO_TENGO_TAREA.into()));
    assert_ne!(p.act(), "pedir_tarea");
    assert!(
        texto(&tocado).contains("Vamos a practicar con ejercicios míos"),
        "{}",
        texto(&tocado)
    );

    let mut dicho = con_foto(Some(4));
    dicho.iniciar();
    dicho.e(Entrada::Texto("espera".into()));
    dicho.e(Entrada::FotoTarea(LecturaTarea::NoDisponible));
    assert_eq!(
        textos(&dicho.e(Entrada::Texto("no tengo".into()))),
        textos(&tocado)
    );
    assert_eq!(dicho.act(), p.act());
}

/// [PROPUESTA] OBJ-11: el tema que se propone se toca con «Sí, fracciones»; a
/// «¿te parece si seguimos aprendiendo fracciones?», «Sí» sigue y «No» cierra.
/// Con el nivel 5, lo que se propone es otro tema y no se ofrece nada.
#[test]
fn opciones_al_elegir_el_tema() {
    let al_elegir = || {
        let mut p = Prueba::new(Some(3), vec![obj(1, TipoObjetivo::Tarea, 5, Some(3))]);
        p.iniciar();
        while p.act().starts_with("tarea") {
            p.reloj.avanzar_min(3);
            p.responder(true);
        }
        assert_eq!(p.act(), "elegir_tema");
        p
    };
    let mut p = al_elegir();
    assert!(
        p.log
            .last()
            .unwrap()
            .texto
            .starts_with("¿Qué te gustaría aprender ahora?"),
        "{}",
        texto(&p.log)
    );
    assert_eq!(p.log.last().unwrap().opciones, ["Sí, fracciones"]);
    p.e(Entrada::Texto("Sí, fracciones".into()));
    assert_eq!(p.act(), "etapa1:4:teoria");

    for (tocada, fin) in [("Sí", "etapa1:4:teoria"), ("No", "terminada")] {
        let mut p = al_elegir();
        let r = p.e(Entrada::Texto("quiero aprender de volcanes".into()));
        assert!(
            r.last()
                .unwrap()
                .texto
                .contains("¿te parece si seguimos aprendiendo fracciones?"),
            "{}",
            texto(&r)
        );
        assert_eq!(opciones_de(&p, &r), ["Sí", "No"]);
        p.e(Entrada::Texto(tocada.into()));
        assert_eq!(p.act(), fin, "{tocada}");
    }

    let mut p = Prueba::new(Some(5), vec![]);
    p.iniciar();
    assert_eq!(p.act(), "elegir_tema");
    assert!(p
        .log
        .last()
        .unwrap()
        .texto
        .starts_with("¿Qué te gustaría aprender ahora?"));
    assert!(p.log.last().unwrap().opciones.is_empty() && p.m.opciones().is_empty());
}

/// [PROPUESTA] Quien solo toca lo que se le ofrece llega al final de su sesión:
/// cada opción es algo que el motor entiende, y caben en una pantalla (de 1 a
/// 4, distintas, de 40 letras como mucho, `contracts/choices`).
#[test]
fn opciones_quien_solo_toca_llega_al_final() {
    let objetivos = [
        vec![obj(1, TipoObjetivo::Tarea, 5, None)],
        vec![obj(1, TipoObjetivo::Preparacion, 6, Some(4))],
        vec![],
    ];
    for (i, objetivos) in objetivos.into_iter().enumerate() {
        for nivel in [None, Some(3), Some(5)] {
            let mut p = Prueba::new(nivel, objetivos.clone());
            p.m.cfg.foto_tarea = true;
            let mut r = p.e(Entrada::Comenzar);
            let mut tocadas = 0;
            for _ in 0..3000 {
                if p.m.terminada() {
                    break;
                }
                let ofrecidas = r.last().map(|m| m.opciones.clone()).unwrap_or_default();
                assert!(ofrecidas.len() <= 4, "{ofrecidas:?}");
                for o in &ofrecidas {
                    assert!(!o.trim().is_empty() && o.chars().count() <= 40, "{o}");
                    assert_eq!(ofrecidas.iter().filter(|x| *x == o).count(), 1, "{o}");
                }
                p.reloj.avanzar_s(30);
                r = match (ofrecidas.first(), p.m.esperando()) {
                    (Some(o), _) => {
                        tocadas += 1;
                        let antes = p.act();
                        let r = p.e(Entrada::Texto(o.clone()));
                        assert!(
                            p.act() != antes || !texto(&r).contains("Te escucho"),
                            "«{o}» no se entendió en {antes}: {}",
                            texto(&r)
                        );
                        r
                    }
                    (None, Esperando::Respuesta { .. } | Esperando::Explicacion { .. }) => {
                        p.responder(true)
                    }
                    (None, Esperando::Conversacion { sugerencias }) => {
                        let t = sugerencias.first().cloned().unwrap_or_else(|| "sí".into());
                        p.e(Entrada::Texto(t))
                    }
                    (None, Esperando::Actividad { .. }) => {
                        p.reloj.avanzar_s(300);
                        p.e(Entrada::Tick)
                    }
                    (None, Esperando::FotoTarea | Esperando::Nada) => {
                        panic!("nada que tocar en {}", p.act())
                    }
                };
            }
            assert!(
                p.m.terminada(),
                "objetivos {i}, nivel {nivel:?}: en {}",
                p.act()
            );
            assert!(tocadas > 0, "objetivos {i}, nivel {nivel:?}");
        }
    }
}
