//! Máquina de estados de la sesión. Es la única que decide el flujo:
//! la IA (en `aule-ai`) solo redacta el texto de Aule, juzga y lee fotos.
//!
//! Cada decisión deja registrada la regla que la produjo (p. ej. "TAM-03").

use crate::banco::{Banco, Ejercicio, Forma, Grafico, NivelContenido};
use crate::config::{ActividadPausa, Config, TipoPausa, TipoPista};
use crate::informe::{self, lista, lista_o, Hecho};
use crate::metricas::{Contexto, Metricas, RegistroNic, RegistroTtm};
use crate::modelo::{
    fecha_larga, leer_fecha, ordenar_objetivos, EstadoObjetivo, FechaDicha, Objetivo, Perfil,
    TamizajeParcial, TipoObjetivo,
};
use crate::reloj::Reloj;
use crate::texto::{self, normalizar};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;

// ───────────────────────────── Tipos públicos ─────────────────────────────

/// Quién redacta un mensaje: tal cual (guion) o la IA (con el guion como respaldo).
/// En `Ia`, `texto` es el respaldo determinista si la IA falla.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "tipo", rename_all = "snake_case")]
pub enum Redaccion {
    Guion,
    Ia { proposito: String },
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "tipo", rename_all = "snake_case")]
pub enum Adjunto {
    Grafico {
        grafico: Grafico,
    },
    Pasos {
        titulo: String,
        enunciado: String,
        pasos: Vec<String>,
        grafico: Option<Grafico>,
    },
    Secuencia {
        pasos: Vec<String>,
    },
    Actividades {
        actividades: Vec<ActividadPausa>,
    },
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Clase {
    Normal,
    Pista,
    Aviso,
    Calma,
    Exito,
    Teoria,
}

#[derive(Clone, Debug, Serialize)]
pub struct Mensaje {
    pub texto: String,
    pub redaccion: Redaccion,
    pub adjunto: Option<Adjunto>,
    pub clase: Clase,
    /// [PROPUESTA] Lo que el Alumno puede tocar en la pantalla, bajo este
    /// mensaje, para contestar lo que pregunta (`Motor::opciones`). Vacío
    /// cuando no pregunta nada con respuestas conocidas.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub opciones: Vec<String>,
}

fn msg(t: impl Into<String>) -> Mensaje {
    Mensaje {
        texto: t.into(),
        redaccion: Redaccion::Guion,
        adjunto: None,
        clase: Clase::Normal,
        opciones: vec![],
    }
}

/// [PROPUESTA] TAR-06: lo que se toca para seguir sin la foto de la Tarea.
/// Dicho o tocado, es un «no tengo» (`no_tiene_tarea`).
pub const NO_TENGO_TAREA: &str = "No tengo mi tarea";
/// [PROPUESTA] Lo que el motor pregunta al terminar cada explicación y cada
/// ejemplo resuelto de la Etapa 1: por voz no hay un botón «Entendido, sigue»,
/// y sin la pregunta el Alumno no sabe que le toca decir que siga.
pub const SEGUIMOS: &str = "¿Seguimos?";

impl Mensaje {
    fn clase(mut self, c: Clase) -> Self {
        self.clase = c;
        self
    }
    fn adj(mut self, a: Adjunto) -> Self {
        self.adjunto = Some(a);
        self
    }
    fn ia(mut self, proposito: impl Into<String>) -> Self {
        self.redaccion = Redaccion::Ia {
            proposito: proposito.into(),
        };
        self
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Modo {
    Tamizaje,
    Teoria,
    EjemploNoAsistido,
    EjemploAsistido,
    Explicar,
    Etapa2,
    Tarea,
    Simulacion,
    Correccion,
    Pausa,
    Conversacion,
}

#[derive(Clone, Debug, Serialize)]
pub struct Tarjeta {
    pub modo: Modo,
    pub titulo: String,
    pub enunciado: String,
    pub grafico: Option<Grafico>,
    pub opciones: Vec<String>,
    pub pide_respuesta: bool,
    pub pide_explicacion: bool,
    /// Ejercicio de cuaderno: se puede responder con foto (HW-02).
    pub es_ejercicio: bool,
    pub nota: Option<String>,
    pub id: Option<String>,
    pub permite_pistas: bool,
    /// "Cómo se escribe…" con ejemplos que nunca son la respuesta ni números del enunciado.
    pub ayuda_formato: Option<String>,
}

/// Qué espera el motor ahora, para que la capa web sepa cómo corregir.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "tipo", rename_all = "snake_case")]
pub enum Esperando {
    Nada,
    Conversacion {
        sugerencias: Vec<String>,
    },
    Respuesta {
        enunciado: String,
        respuesta: String,
        opciones: Vec<String>,
        forma: Forma,
        pide_explicacion: bool,
        criterio: Option<String>,
        claves: Vec<Vec<String>>,
        minimo_claves: usize,
    },
    Explicacion {
        pregunta: String,
        criterio: String,
        claves: Vec<Vec<String>>,
        minimo_claves: usize,
    },
    Actividad {
        opciones: Vec<String>,
    },
    /// [PROPUESTA] TAR-05: la foto de la Tarea, que se lee fuera del motor
    /// (`Entrada::FotoTarea`). Lo que diga el Alumno mientras tanto llega como
    /// texto: «no tengo» sigue sin ella (TAR-06).
    FotoTarea,
}

/// [PROPUESTA] E1-06: ¿lo dicho empieza asintiendo («Ya,», «Sí, listo.», «Ah,
/// ya,») y en lo que sigue no pregunta, no objeta ni pide que se le repita?
/// «Ya, entendí. Los pedazos siguen siendo quintos.» avanza; «Sí, ¿pero por
/// qué?» y «Ya, pero no me sale» son conversación. Lo que solo asiente, sin
/// nada más, ya lo toman las palabras de avance.
fn empieza_asintiendo(t: &str, avance: &[&str]) -> bool {
    const MULETILLAS: [&str; 6] = ["ah", "eh", "oh", "mmm", "aja", "bueno"];
    let corta = |c: char| matches!(c, ',' | '.' | ';' | ':' | '!' | '…');
    let mut resto = t.trim();
    let mut asintio = false;
    // Las frases cortas con que empieza: muletillas y palabras de avance.
    while let Some(corte) = resto.find(corta) {
        let frase = normalizar(&resto[..corte]);
        let palabras: Vec<&str> = frase.split_whitespace().collect();
        let solo_asiente = !palabras.is_empty()
            && palabras.len() <= 3
            && palabras
                .iter()
                .all(|w| avance.contains(w) || MULETILLAS.contains(w));
        if !solo_asiente {
            break;
        }
        asintio |= palabras.iter().any(|w| avance.contains(w));
        resto = resto[corte..].trim_start_matches(|c: char| corta(c) || c.is_whitespace());
    }
    if !asintio || resto.is_empty() {
        return false;
    }
    let n = normalizar(resto);
    let objeta = resto.contains('?')
        || resto.contains('¿')
        || n == "no"
        || n.starts_with("no ")
        || n.starts_with("pero ")
        || n.contains(" pero ")
        || n.ends_with(" no se")
        || ["no entend", "no comprend", "otra vez", "repite", "no se "]
            .iter()
            .any(|p| n.contains(p));
    !objeta
}

/// [PROPUESTA] TAR-05: lo que se leyó en una foto de la Tarea, fuera del
/// motor. Llega solo el nivel, nunca la foto (DAT-03).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "tipo", rename_all = "snake_case")]
pub enum LecturaTarea {
    /// Una Tarea del tema: el nivel más alto que se ve en ella, y la confianza
    /// de la lectura, de 0 a 100.
    Leida { nivel: u8, confianza: u8 },
    /// Una Tarea de otro curso o tema.
    OtroTema,
    /// En la foto no se ve una Tarea.
    SinTarea,
    /// La Tarea no se ve bien.
    Borrosa,
    /// No se pudo mirar la foto: quien la lee falló o no respondió.
    NoDisponible,
}

/// Resultado de corregir (determinista y/o IA), calculado fuera del motor.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Calificacion {
    pub respuesta_leida: Option<String>,
    pub respuesta_correcta: bool,
    #[serde(default)]
    pub forma_incorrecta: bool,
    pub explicacion_correcta: Option<bool>,
    pub comentario: Option<String>,
    #[serde(default)]
    pub ilegible: bool,
}

#[derive(Clone, Debug)]
pub enum Entrada {
    Comenzar,
    Texto(String),
    Calificada(Calificacion),
    Ayuda,
    Cansado,
    SalirTamizaje,
    Actividad(usize),
    Tick,
    /// Panel: saltarse la espera de la pausa (PAU-06).
    SaltarPausa,
    /// Mensaje libre del chat, ya contestado por la IA (o el guion), con su intención.
    /// El motor decide qué hacer con la intención; nunca lo toma como respuesta ni explicación.
    Chat {
        texto: String,
        intencion: crate::conversacion::Intencion,
    },
    /// [PROPUESTA] TAR-05: lo que se leyó en la foto de la Tarea que el motor pidió.
    FotoTarea(LecturaTarea),
}

#[derive(Clone, Debug, Serialize)]
pub struct VistaObjetivo {
    pub tipo: String,
    pub curso: String,
    pub tema: String,
    pub fecha: Option<String>,
    pub nivel_objetivo: Option<u8>,
    pub estado: String,
    pub actual: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct VistaPausa {
    pub restante_s: u64,
    pub actividad: Option<ActividadPausa>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Vista {
    pub iniciada: bool,
    pub terminada: bool,
    pub etapa: String,
    pub progreso: String,
    pub tarjeta: Option<Tarjeta>,
    pub esperando: Esperando,
    pub transcurrido_s: u64,
    pub pausa: Option<VistaPausa>,
    pub regla: String,
    pub registro: Vec<String>,
    pub niveles: Vec<(String, Option<u8>)>,
    pub objetivos: Vec<VistaObjetivo>,
    pub metricas: Metricas,
    pub informe: Option<Vec<String>>,
    pub boton_ayuda: bool,
    pub boton_cansado: bool,
    pub boton_salir_tamizaje: bool,
    pub alumno: String,
    pub proyeccion_min: f64,
    pub pausas_tomadas: u32,
    pub aviso_dado: bool,
    pub estimacion_sesiones: Option<u32>,
    /// Mapa de la sesión para el Alumno: pasos hechos, el actual y los que vienen.
    pub ruta: Vec<PasoRuta>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct PasoRuta {
    pub nombre: String,
    pub detalle: String,
    /// "hecho", "actual" o "pendiente".
    pub estado: String,
}

// ───────────────────────────── Estado interno ─────────────────────────────

#[derive(Clone, Debug)]
struct Ex {
    ej: Ejercicio,
    inicio_ms: u64,
    /// Pistas dadas (índice en el orden de PIS-02).
    pistas: usize,
    paso_a_paso: bool,
    fallos: u32,
    ayuda_usada: bool,
    pista_tiempo: bool,
}

impl Ex {
    fn new(ej: Ejercicio, ahora: u64) -> Self {
        Ex {
            ej,
            inicio_ms: ahora,
            pistas: 0,
            paso_a_paso: false,
            fallos: 0,
            ayuda_usada: false,
            pista_tiempo: false,
        }
    }
}

#[derive(Clone, Debug)]
struct Tam {
    tema: String,
    nivel: u8,
    respuestas: Vec<(u8, bool)>,
    actual: Ejercicio,
    usadas: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq)]
enum FaseE1 {
    Teoria(usize),
    NoAsistido(usize),
    Asistido {
        ej: usize,
        paso: usize,
        fallos: u8,
        /// [PROPUESTA] Hasta ahora, cada paso de este ejemplo salió bien al
        /// primer intento y sin pistas.
        limpio: bool,
    },
    Explicar {
        pistas: usize,
        repaso_hecho: bool,
    },
}

#[derive(Clone, Debug)]
struct E1 {
    nivel: u8,
    fase: FaseE1,
}

#[derive(Clone, Debug)]
struct E2 {
    nivel: u8,
    lista: Vec<Ejercicio>,
    idx: usize,
    actual: Ex,
    primer: Vec<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum ModoPractica {
    Tarea,
    Simulacion,
    Correccion,
}

#[derive(Clone, Debug)]
struct Item {
    ej: Ejercicio,
    nota: Option<String>,
}

#[derive(Clone, Debug)]
struct Prac {
    modo: ModoPractica,
    items: Vec<Item>,
    idx: usize,
    actual: Ex,
    resultados: Vec<bool>,
    ciclos: u32,
    marcados: Vec<usize>,
}

#[derive(Clone, Debug)]
struct Pausa {
    previa: Box<Actividad>,
    inicio_ms: u64,
    eleccion: Option<usize>,
    /// Si empezó porque el Alumno dijo que está cansado (PAU-05).
    por_cansancio: bool,
}

/// [PROPUESTA] TAR-05: la foto de la Tarea del objetivo en curso.
#[derive(Clone, Copy, Debug, PartialEq)]
enum EstadoFoto {
    /// Todavía no se vio.
    Pendiente,
    /// Se leyó su nivel, que es el Nivel objetivo.
    Leida { nivel: u8 },
    /// Se sigue sin ella (TAR-07).
    SinFoto,
}

#[derive(Clone, Debug)]
enum Actividad {
    NoIniciada,
    PedirFecha(usize),
    Bienvenida,
    ElegirTema {
        intentos: u8,
    },
    /// [PROPUESTA] TAR-05: se espera la foto de la Tarea. `nivel` es el del
    /// Alumno; `intentos`, las fotos que no se pudieron leer; `charlas`, los
    /// turnos de conversación sin foto (TAR-06).
    PedirTarea {
        nivel: u8,
        intentos: u8,
        charlas: u8,
        tras_tamizaje: bool,
    },
    Tamizaje(Box<Tam>),
    Etapa1(E1),
    Etapa2(Box<E2>),
    Practica(Box<Prac>),
    Pausa(Box<Pausa>),
    /// Marcador: al volver de una pausa, decidir el siguiente paso.
    Siguiente,
    Terminada,
}

/// Unidad de tiempo proyectada: ejercicio o algo que no es ejercicio (Etapa 1).
#[derive(Clone, Copy, Debug)]
enum Unidad {
    Ejercicio(f64),
    Otro(f64),
}

const CALMA: [&str; 5] = [
    "Tranquilo, con calma.",
    "¡Tú puedes!",
    "Respira y sigue a tu ritmo.",
    "Lo importante es que me cuentes cómo lo pensaste.",
    "Vamos con la siguiente, sin apuro.",
];

const EXITO: [&str; 6] = [
    "¡Muy bien!",
    "¡Excelente!",
    "¡Eso es!",
    "¡Bien hecho!",
    "¡Perfecto!",
    "¡Qué bien lo hiciste!",
];

// ───────────────────────────── Motor ─────────────────────────────

/// Vueltas a la Etapa 1 de un mismo nivel en una sesión.
const MAX_VUELTAS_E1: u32 = 2;

pub struct Motor {
    pub cfg: Config,
    banco: Arc<Banco>,
    reloj: Arc<dyn Reloj>,
    pub perfil: Perfil,
    pub objetivos: Vec<Objetivo>,
    obj_actual: Option<usize>,
    act: Actividad,
    pila: Vec<Actividad>,
    inicio_ms: u64,
    iniciada: bool,
    pausas_tomadas: u32,
    /// [PROPUESTA] Turnos de conversación seguidos sobre la explicación o el
    /// ejemplo resuelto en pantalla (`Config::charlas_por_explicacion`).
    charlas_explicacion: u8,
    /// [PROPUESTA] Turnos de conversación seguidos mientras el motor espera una
    /// respuesta (`Config::charlas_por_pregunta`).
    charlas_pregunta: u8,
    pausa_total_ms: u64,
    e1_lista: Option<u8>,
    remediacion: VecDeque<u8>,
    sim_pendiente: Option<Vec<u8>>,
    sim_ronda: usize,
    sim_errores_informados: bool,
    final_hecho: bool,
    extra_tema: Option<String>,
    extra_objetivo: Option<u8>,
    extra_niveles: Vec<u8>,
    aviso_dado: bool,
    cupo: Option<u32>,
    tamizaje_salido_hoy: BTreeSet<String>,
    ttm_inicio: BTreeMap<u8, u64>,
    niveles_hoy: Vec<u8>,
    pub hechos: Vec<Hecho>,
    pub metricas: Metricas,
    regla: String,
    registro: Vec<String>,
    contador: usize,
    sesion_adicional: Option<String>,
    estimacion_sesiones: Option<u32>,
    /// Razón tiempo real / tiempo promedio de los ejercicios resueltos (para proyectar).
    ritmo: Vec<f64>,
    /// Veces que se empezó la Etapa 1 de cada nivel (para variar al repetir).
    e1_vueltas: BTreeMap<u8, u32>,
    /// Pasos de la ruta ya empezados (clave, nombre, detalle).
    ruta_hecha: Vec<(String, String, String)>,
    /// [PROPUESTA] Niveles del plan que se le contó al Alumno (`decir_plan`),
    /// hasta que empieza el primero.
    plan_dicho: Vec<u8>,
    /// TAM-08: el tema y el nivel de un Tamizaje que terminó, hasta que su
    /// resultado y su plan van al Informe (`registrar_plan`).
    plan_pendiente: Option<(String, u8)>,
    /// [PROPUESTA] TAR-05: la foto de la Tarea del objetivo en curso.
    foto: EstadoFoto,
}

impl Motor {
    pub fn new(
        cfg: Config,
        banco: Arc<Banco>,
        reloj: Arc<dyn Reloj>,
        perfil: Perfil,
        objetivos: Vec<Objetivo>,
    ) -> Self {
        Motor {
            cfg,
            banco,
            reloj,
            perfil,
            objetivos,
            obj_actual: None,
            act: Actividad::NoIniciada,
            pila: vec![],
            inicio_ms: 0,
            iniciada: false,
            pausas_tomadas: 0,
            charlas_explicacion: 0,
            charlas_pregunta: 0,
            pausa_total_ms: 0,
            e1_lista: None,
            remediacion: VecDeque::new(),
            sim_pendiente: None,
            sim_ronda: 0,
            sim_errores_informados: false,
            final_hecho: false,
            extra_tema: None,
            extra_objetivo: None,
            extra_niveles: vec![],
            aviso_dado: false,
            cupo: None,
            tamizaje_salido_hoy: BTreeSet::new(),
            ttm_inicio: BTreeMap::new(),
            niveles_hoy: vec![],
            hechos: vec![],
            metricas: Metricas::default(),
            regla: "—".into(),
            registro: vec![],
            contador: 0,
            sesion_adicional: None,
            estimacion_sesiones: None,
            ritmo: vec![],
            e1_vueltas: BTreeMap::new(),
            ruta_hecha: vec![],
            plan_dicho: vec![],
            plan_pendiente: None,
            foto: EstadoFoto::Pendiente,
        }
    }

    // ─────────── utilidades ───────────

    fn ahora(&self) -> u64 {
        self.reloj.ahora_ms()
    }

    /// Minutos de sesión transcurridos (incluye pausas).
    pub fn transcurrido_min(&self) -> f64 {
        if !self.iniciada {
            return 0.0;
        }
        (self.ahora().saturating_sub(self.inicio_ms)) as f64 / 60000.0
    }

    fn activo_ms(&self) -> u64 {
        let pausa_en_curso = match &self.act {
            Actividad::Pausa(p) => self.ahora().saturating_sub(p.inicio_ms),
            _ => 0,
        };
        self.ahora()
            .saturating_sub(self.inicio_ms)
            .saturating_sub(self.pausa_total_ms + pausa_en_curso)
    }

    fn aplicar(&mut self, id: &str, que: &str) {
        let min = self.transcurrido_min();
        self.regla = format!("{id} · {que}");
        self.registro
            .push(format!("[{:>4.1} min] {id} · {que}", min));
        if self.registro.len() > 200 {
            self.registro.remove(0);
        }
    }

    fn rota<'a>(&mut self, v: &'a [&'a str]) -> &'a str {
        self.contador += 1;
        v[self.contador % v.len()]
    }

    fn nombre(&self) -> String {
        self.perfil.nombre_alumno.clone()
    }

    fn interes(&self) -> Option<String> {
        self.banco
            .interes_de(&self.perfil.intereses)
            .map(|i| i.clave.clone())
    }

    fn nivel_c(&self, n: u8) -> NivelContenido {
        self.banco.nivel(n).clone()
    }

    fn tema_principal(&self) -> String {
        self.banco.tema.clone()
    }

    fn nivel_de(&self, tema: &str) -> Option<u8> {
        self.perfil.niveles.get(tema).copied()
    }

    // ─────────── API ───────────

    pub fn entrada(&mut self, e: Entrada) -> Vec<Mensaje> {
        let mut out = vec![];
        // Lo que no es conversación ni el paso del tiempo corta la racha de
        // conversación ante una pregunta pendiente (CHAT-02).
        if !matches!(e, Entrada::Chat { .. } | Entrada::Tick) {
            self.charlas_pregunta = 0;
        }
        match e {
            Entrada::Comenzar => self.comenzar(&mut out),
            Entrada::Tick => self.tick(&mut out),
            Entrada::SaltarPausa => {
                if matches!(self.act, Actividad::Pausa(_)) {
                    self.aplicar("PAU-06", "Quien presenta se saltó la espera de la pausa");
                    self.terminar_pausa(&mut out);
                }
            }
            Entrada::Cansado => self.cansado(&mut out),
            Entrada::Ayuda => self.ayuda(&mut out),
            Entrada::SalirTamizaje => self.salir_tamizaje(&mut out),
            Entrada::Actividad(i) => self.elegir_actividad(i, &mut out),
            Entrada::Texto(t) => self.texto(t, &mut out),
            Entrada::Calificada(c) => self.calificada(c, &mut out),
            Entrada::Chat { texto, intencion } => self.chat(&texto, intencion, &mut out),
            Entrada::FotoTarea(lectura) => self.foto_tarea(lectura, &mut out),
        }
        // [PROPUESTA] Lo último que dijo pregunta lo que el motor espera ahora:
        // lo que se puede tocar para contestarlo va con ese mensaje.
        let opciones = self.opciones();
        if let Some(ultimo) = out.last_mut().filter(|_| !opciones.is_empty()) {
            ultimo.opciones = opciones;
        }
        out
    }

    /// [PROPUESTA] Las respuestas que el Alumno puede tocar en la pantalla para
    /// contestar lo que el motor le acaba de preguntar, cuando las conoce. Tocar
    /// una es decirla: llega como `Entrada::Texto` con sus palabras, y el motor
    /// hace lo mismo que si la hubiera dicho o escrito. Solo las que el motor
    /// sabe seguir: a «¿Empezamos?» cualquier respuesta empieza, así que no se
    /// ofrece un «No» que haría lo mismo. Las de un ejercicio están en su
    /// tarjeta (`Tarjeta::opciones`).
    pub fn opciones(&self) -> Vec<String> {
        match &self.act {
            Actividad::Bienvenida => vec!["Sí".into()],
            // TAR-06: «no tengo» sigue sin la foto.
            Actividad::PedirTarea { .. } => vec![NO_TENGO_TAREA.into()],
            // PAU-06: una de las actividades, mientras no eligió ninguna.
            Actividad::Pausa(p) if p.eleccion.is_none() => self
                .cfg
                .actividades_pausa
                .iter()
                .map(|a| a.nombre.clone())
                .collect(),
            // OBJ-11: el tema que se le propone, si no lo domina ya; con el
            // nivel 5 se le propone otro que no tenemos, y cualquier respuesta cierra.
            Actividad::ElegirTema { intentos: 0 } => {
                let tema = self.tema_principal();
                if self.nivel_de(&tema) == Some(self.cfg.niveles_por_tema) {
                    vec![]
                } else {
                    vec![format!("Sí, {}", tema.to_lowercase())]
                }
            }
            // «¿Te parece si seguimos aprendiendo…?»: sí sigue, no cierra.
            Actividad::ElegirTema { .. } => vec!["Sí".into(), "No".into()],
            // «¿Seguimos?»: las dos respuestas que el motor ya sugería ahí.
            Actividad::Etapa1(e) if matches!(e.fase, FaseE1::Teoria(_) | FaseE1::NoAsistido(_)) => {
                match self.esperando() {
                    Esperando::Conversacion { sugerencias } => sugerencias,
                    _ => vec![],
                }
            }
            _ => vec![],
        }
    }

    // ─────────── inicio ───────────

    fn comenzar(&mut self, out: &mut Vec<Mensaje>) {
        if self.iniciada {
            return;
        }
        self.iniciada = true;
        self.inicio_ms = self.ahora();
        let (curso, tema) = (self.banco.curso.clone(), self.banco.tema.clone());
        let nombre = self.nombre();

        // OBJ-08: lo que no cubrimos se dice con honestidad y se registra.
        let mut no_cubiertos = vec![];
        for o in self.objetivos.iter_mut() {
            if o.estado == EstadoObjetivo::Pendiente && !o.cubierto_por(&curso, &tema) {
                o.estado = EstadoObjetivo::NoCubierto;
                no_cubiertos.push(o.clone());
            }
        }
        for o in &no_cubiertos {
            self.aplicar(
                "OBJ-08",
                &format!(
                    "{} de {} / {}: no lo cubrimos",
                    o.tipo.nombre(),
                    o.curso,
                    o.tema
                ),
            );
            let que = match o.tipo {
                TipoObjetivo::Tarea => "una tarea",
                TipoObjetivo::Preparacion => "una evaluación que viene",
                TipoObjetivo::Correccion => "una evaluación para corregir",
                TipoObjetivo::Extracurricular => "un tema",
            };
            self.hechos.push(Hecho::NoCubierto {
                curso: o.curso.clone(),
                tema: o.tema.clone(),
                que: que.into(),
            });
        }

        // OBJ-05 / OBJ-11: sin tareas ni evaluaciones → Aprendizaje extracurricular.
        let hay_pendientes = self
            .objetivos
            .iter()
            .any(|o| o.estado == EstadoObjetivo::Pendiente);
        if !hay_pendientes {
            self.agregar_extracurricular();
        }

        let interes = self
            .banco
            .interes_de(&self.perfil.intereses)
            .map(|i| i.nombre.clone());
        let saludo = format!(
            "¡Hola, {nombre}! Soy Aule. Qué gusto verte hoy.{}",
            interes
                .map(|i| format!(" Hoy los ejercicios van de {}.", i.to_lowercase()))
                .unwrap_or_default()
        );
        out.push(msg(saludo).ia(
            "Saludo inicial cálido y breve (2 frases máximo) al Alumno, mencionando de pasada uno de sus intereses. No hagas preguntas todavía.",
        ));
        if !no_cubiertos.is_empty() {
            let d: Vec<String> = no_cubiertos
                .iter()
                .map(|o| format!("{} de {}", o.tema, o.curso))
                .collect();
            out.push(msg(format!(
                "Vi que también tienes algo de {}. Te soy honesto: todavía no sé enseñar ese tema. Lo anoto y se lo cuento a tus padres para que lo revisen con tu Docente.",
                lista(&d)
            )));
        }
        self.pedir_fechas_o_plan(out);
    }

    fn agregar_extracurricular(&mut self) {
        let id = self.objetivos.iter().map(|o| o.id).max().unwrap_or(0) + 1;
        let tema = self.tema_principal();
        self.objetivos.push(Objetivo {
            id,
            tipo: TipoObjetivo::Extracurricular,
            curso: self.banco.curso.clone(),
            tema,
            fecha: None,
            sin_fecha_confirmado: true,
            nivel_objetivo: None,
            tarea_id: None,
            evaluacion_id: None,
            falladas: vec![],
            estado: EstadoObjetivo::Pendiente,
        });
        // OBJ-11: si la sesión no ha comenzado decide el padre (sugerencia cargada).
        if let Some(s) = self
            .perfil
            .sugerencia_padre
            .clone()
            .filter(|s| !s.trim().is_empty())
        {
            self.aplicar("OBJ-11", &format!("Sugerencia del Padre de familia: {s}"));
            self.extra_tema = Some(s);
        } else {
            self.aplicar(
                "OBJ-11",
                "Sin tareas ni evaluaciones: el Alumno elige el tema",
            );
        }
    }

    fn pedir_fechas_o_plan(&mut self, out: &mut Vec<Mensaje>) {
        // OBJ-10: sin fecha se pregunta hasta conseguirla o hasta que digan que no hay.
        if let Some(i) = self.objetivos.iter().position(|o| {
            o.estado == EstadoObjetivo::Pendiente
                && o.tipo != TipoObjetivo::Extracurricular
                && o.fecha.is_none()
                && !o.sin_fecha_confirmado
        }) {
            let o = &self.objetivos[i];
            let q = match o.tipo {
                TipoObjetivo::Tarea => format!("¿Para qué día es tu Tarea de {}?", o.tema),
                TipoObjetivo::Preparacion => format!("¿Qué día es tu Evaluación de {}?", o.tema),
                _ => format!("¿Qué día fue tu Evaluación de {}?", o.tema),
            };
            self.aplicar("OBJ-10", "Objetivo sin fecha: se pregunta");
            out.push(msg(q));
            self.act = Actividad::PedirFecha(i);
            return;
        }
        ordenar_objetivos(&mut self.objetivos);
        self.aplicar(
            "OBJ-09",
            "Objetivos ordenados: fecha más cercana, luego tipo",
        );
        let pend: Vec<String> = self
            .objetivos
            .iter()
            .filter(|o| o.estado == EstadoObjetivo::Pendiente)
            .map(|o| self.describir_objetivo(o))
            .collect();
        let texto = if pend.len() == 1 {
            format!("Hoy vamos a trabajar en {}.", pend[0])
        } else {
            format!(
                "Hoy tenemos {} cosas, en este orden: {}.",
                pend.len(),
                lista(&pend)
            )
        };
        out.push(msg(format!("{texto} ¿Empezamos?")));
        self.act = Actividad::Bienvenida;
    }

    fn describir_objetivo(&self, o: &Objetivo) -> String {
        let f = o
            .fecha
            .map(|f| format!(" para el {}", fecha_larga(f)))
            .unwrap_or_default();
        match o.tipo {
            TipoObjetivo::Tarea => format!("tu Tarea de {}{f}", o.tema),
            TipoObjetivo::Preparacion => format!("prepararnos para tu Evaluación de {}{f}", o.tema),
            TipoObjetivo::Correccion => {
                let f = o
                    .fecha
                    .map(|f| format!(" del {}", fecha_larga(f)))
                    .unwrap_or_default();
                format!("corregir juntos tu Evaluación de {}{f}", o.tema)
            }
            TipoObjetivo::Extracurricular => match &self.extra_tema {
                Some(t) => format!("aprender algo nuevo de {t}"),
                None => "aprender algo nuevo que tú elijas".into(),
            },
        }
    }

    // ─────────── texto libre ───────────

    fn texto(&mut self, t: String, out: &mut Vec<Mensaje>) {
        let n = normalizar(&t);
        match self.act.clone() {
            Actividad::NoIniciada => {
                self.comenzar(out);
            }
            Actividad::PedirFecha(i) => match leer_fecha(&t, self.perfil.hoy) {
                FechaDicha::Fecha(f) => {
                    self.objetivos[i].fecha = Some(f);
                    out.push(msg(format!("¡Anotado: {}!", fecha_larga(f))));
                    self.pedir_fechas_o_plan(out);
                }
                FechaDicha::NoHay => {
                    self.objetivos[i].sin_fecha_confirmado = true;
                    self.aplicar("OBJ-10", "Dijeron que no hay fecha");
                    out.push(msg("Está bien, sin fecha."));
                    self.pedir_fechas_o_plan(out);
                }
                FechaDicha::NoSe => {
                    self.aplicar("OBJ-10", "No se entendió la fecha: se vuelve a preguntar");
                    out.push(msg(
                        "No te preocupes. Dime el día, por ejemplo «el jueves» o «el 15». Si no hay fecha, dime «no hay».",
                    ));
                }
            },
            Actividad::Bienvenida => {
                if !texto::es_si(&t) && n.split_whitespace().count() > 2 {
                    out.push(
                        msg("¡Gracias por contarme! Vamos a empezar.")
                            .ia("El Alumno respondió algo al saludo. Responde en 1 o 2 frases breves y cálidas a lo que dijo y dile que empezamos. No hagas preguntas."),
                    );
                }
                self.act = Actividad::Siguiente;
                self.avanzar(out);
            }
            Actividad::ElegirTema { intentos } => self.elegir_tema(&t, intentos, out),
            Actividad::PedirTarea { .. } => self.texto_pedir_tarea(&t, out),
            Actividad::Etapa1(e1) => self.texto_e1(e1, &t, out),
            Actividad::Pausa(p) => {
                if let Some(k) = self.leer_actividad(&t) {
                    self.elegir_actividad(k, out);
                } else if p.eleccion.is_some() && dice_que_volvio(&t) {
                    // [PROPUESTA] Por voz no hay un botón para volver: si dice
                    // que ya volvió después de la actividad, se sigue.
                    self.aplicar("PAU-06", "El Alumno dijo que ya volvió");
                    self.terminar_pausa(out);
                } else if p.eleccion.is_none() {
                    // [PROPUESTA] Sin elegir una, se le propone una (`actividad_propuesta`).
                    // Si dice que ya volvió sin haber hecho ninguna, primero se le responde.
                    if dice_que_volvio(&t) {
                        out.push(
                            msg("¡Qué bueno que estás aquí! Antes de seguir, hagamos una actividad cortita para recargar energía:")
                                .clase(Clase::Calma),
                        );
                    }
                    let k = self.actividad_propuesta(p.por_cansancio);
                    self.elegir_actividad(k, out);
                } else {
                    let r = self.pausa_restante_s(&p);
                    out.push(msg(format!(
                        "Estamos en la Pausa activa. Nos quedan {} para volver.",
                        minutos_y_segundos(r)
                    )));
                }
            }
            Actividad::Terminada => {
                out.push(
                    msg("¡Gracias! Hoy ya terminamos. Nos vemos en la próxima sesión.")
                        .ia("La sesión ya terminó. Responde brevemente y con cariño a lo que dijo el Alumno, y despídete."),
                );
            }
            Actividad::Tamizaje(_)
            | Actividad::Etapa2(_)
            | Actividad::Practica(_)
            | Actividad::Siguiente => self.texto_lateral(&t, out),
        }
    }

    /// Texto durante un ejercicio que no es una respuesta.
    fn texto_lateral(&mut self, t: &str, out: &mut Vec<Mensaje>) {
        let n = normalizar(t);
        if n.contains("ayuda")
            || n.contains("no se")
            || n.contains("no entiendo")
            || n.contains("pista")
        {
            return self.ayuda(out);
        }
        if n.contains("cansad") || n.contains("sueno") {
            return self.cansado(out);
        }
        if (n.contains("sesion") || n.contains("clase")) && self.aviso_dado {
            if let FechaDicha::Fecha(f) = leer_fecha(t, self.perfil.hoy) {
                self.sesion_adicional = Some(fecha_larga(f));
                self.aplicar("SES-07", "El Alumno pidió una sesión adicional");
                out.push(msg(format!(
                    "¡Anotado! Le comento a tus padres que te gustaría una sesión adicional el {}.",
                    fecha_larga(f)
                )));
                return;
            }
        }
        out.push(msg("Te escucho. Cuando quieras, seguimos con el ejercicio.").ia(
            "El Alumno dijo algo durante un ejercicio. Responde en 1 o 2 frases cortas a lo que dijo y anímalo a seguir con su ejercicio. Nunca des la respuesta ni pistas del ejercicio.",
        ));
    }

    // ─────────── siguiente paso ───────────

    fn objetivo_vigente(&mut self) -> Option<usize> {
        if let Some(i) = self.obj_actual {
            if self.objetivos[i].estado == EstadoObjetivo::EnCurso {
                return Some(i);
            }
        }
        let i = self
            .objetivos
            .iter()
            .position(|o| o.estado == EstadoObjetivo::Pendiente)?;
        self.objetivos[i].estado = EstadoObjetivo::EnCurso;
        self.obj_actual = Some(i);
        self.final_hecho = false;
        self.e1_lista = None;
        self.remediacion.clear();
        self.sim_pendiente = None;
        self.sim_ronda = 0;
        self.sim_errores_informados = false;
        self.aviso_dado = false;
        // Cada Tarea tiene su foto (TAR-05).
        self.foto = EstadoFoto::Pendiente;
        let o = self.objetivos[i].clone();
        self.aplicar(
            "OBJ-07",
            &format!("Objetivo de la sesión: {} de {}", o.tipo.nombre(), o.tema),
        );
        Some(i)
    }

    /// OBJ-07: nivel objetivo según el tipo.
    fn nivel_objetivo(&self, i: usize) -> u8 {
        let o = &self.objetivos[i];
        match o.tipo {
            TipoObjetivo::Tarea => o
                .nivel_objetivo
                .or_else(|| {
                    o.tarea_id
                        .as_ref()
                        .and_then(|t| self.banco.tareas.iter().find(|x| &x.id == t))
                        .map(|t| t.nivel)
                })
                .unwrap_or(4),
            TipoObjetivo::Preparacion => o.nivel_objetivo.unwrap_or(4),
            TipoObjetivo::Correccion => {
                // COR-03: el nivel que pedía la evaluación, solo donde falló.
                self.preguntas_falladas(i)
                    .iter()
                    .map(|e| e.nivel)
                    .max()
                    .or(o.nivel_objetivo)
                    .unwrap_or(4)
            }
            TipoObjetivo::Extracurricular => self.extra_objetivo.unwrap_or(5),
        }
    }

    fn preguntas_falladas(&self, i: usize) -> Vec<Ejercicio> {
        let o = &self.objetivos[i];
        let Some(ev) = o
            .evaluacion_id
            .as_ref()
            .and_then(|id| self.banco.evaluaciones.iter().find(|e| &e.id == id))
            .or(self.banco.evaluaciones.first())
        else {
            return vec![];
        };
        let idx: Vec<usize> = if o.falladas.is_empty() {
            ev.preguntas
                .iter()
                .enumerate()
                .filter(|(_, p)| p.fallada)
                .map(|(k, _)| k)
                .collect()
        } else {
            o.falladas.clone()
        };
        idx.iter()
            .filter_map(|k| ev.preguntas.get(*k))
            .map(|p| p.ejercicio.clone())
            .collect()
    }

    fn avanzar(&mut self, out: &mut Vec<Mensaje>) {
        self.act = Actividad::Siguiente;
        if self.frontera(out) {
            return;
        }
        if let Some(a) = self.pila.pop() {
            self.e1_lista = None;
            self.act = a;
            out.push(msg("¡Listo el repaso! Volvamos a tu ejercicio."));
            self.presentar(out, true);
            return;
        }
        let Some(oi) = self.objetivo_vigente() else {
            // No queda nada: SES-02 → extracurricular; si ya se hizo, cerrar.
            if self.transcurrido_min() < self.cfg.umbral_extracurricular_min as f64
                && !self
                    .objetivos
                    .iter()
                    .any(|o| o.tipo == TipoObjetivo::Extracurricular)
            {
                self.aplicar(
                    "SES-02",
                    "Terminó antes de 30 minutos y no hay pendientes: Aprendizaje extracurricular",
                );
                self.agregar_extracurricular_en_sesion(out);
                return self.avanzar(out);
            }
            return self.cerrar(out);
        };
        let o = self.objetivos[oi].clone();
        let tema = o.tema.clone();

        // Extracurricular: primero saber el tema.
        if o.tipo == TipoObjetivo::Extracurricular && self.extra_tema.is_none() {
            if self.nivel_de(&tema) == Some(self.cfg.niveles_por_tema) {
                return self.rut09(out);
            }
            return self.preguntar_tema(out, 0);
        }

        // TAM-06: tamizaje incompleto de una sesión anterior se retoma.
        let parcial = self.perfil.tamizaje_parcial.contains_key(&tema)
            && !self.tamizaje_salido_hoy.contains(&tema);
        let nivel = match self.nivel_de(&tema) {
            Some(n) if !parcial => n,
            _ => {
                if self.tamizaje_salido_hoy.contains(&tema) {
                    self.nivel_de(&tema).unwrap_or(0)
                } else {
                    return self.iniciar_tamizaje(&tema, out);
                }
            }
        };

        // Extracurricular: nivel inmediato siguiente (OBJ-07, RUT-04, RUT-09).
        if o.tipo == TipoObjetivo::Extracurricular && self.extra_objetivo.is_none() {
            if nivel >= self.cfg.niveles_por_tema {
                return self.rut09(out);
            }
            self.extra_objetivo = Some(nivel + 1);
            self.aplicar(
                "RUT-04",
                &format!("Extracurricular: Etapa 1 y 2 del nivel {}", nivel + 1),
            );
        }

        // [PROPUESTA] TAR-05: con el nivel del Alumno ya conocido, antes de
        // decidir la ruta se ve la Tarea, cuyo nivel es el Nivel objetivo.
        if self.foto_por_pedir(oi) {
            return self.pedir_foto_tarea(nivel, out);
        }

        // PRE-09: remediación de la simulación.
        if let Some(&l) = self.remediacion.front() {
            return if self.e1_lista == Some(l) {
                self.iniciar_e2(l, out)
            } else {
                self.iniciar_e1(l, out)
            };
        }

        let objetivo = self.nivel_objetivo(oi);
        if nivel < objetivo {
            let l = nivel + 1;
            if self.e1_lista != Some(l) {
                self.aplicar(
                    "RUT-03",
                    &format!("Nivel {nivel} < objetivo {objetivo}: Etapa 1 del nivel {l}"),
                );
                return self.iniciar_e1(l, out);
            }
            return self.iniciar_e2(l, out);
        }

        match o.tipo {
            TipoObjetivo::Extracurricular => self.rut05_08(out),
            _ if self.final_hecho => self.objetivo_completado(out),
            TipoObjetivo::Tarea => {
                self.aplicar(
                    "RUT-02",
                    &format!("Nivel {nivel} ≥ objetivo {objetivo}: a hacer la Tarea"),
                );
                self.iniciar_practica(ModoPractica::Tarea, out)
            }
            TipoObjetivo::Preparacion => {
                self.aplicar(
                    "RUT-02",
                    &format!("Nivel {nivel} ≥ objetivo {objetivo}: Simulación"),
                );
                self.iniciar_practica(ModoPractica::Simulacion, out)
            }
            TipoObjetivo::Correccion => {
                self.aplicar(
                    "COR-05",
                    &format!("Nivel {nivel} ≥ objetivo {objetivo}: resolver lo que falló"),
                );
                self.iniciar_practica(ModoPractica::Correccion, out)
            }
        }
    }

    fn agregar_extracurricular_en_sesion(&mut self, out: &mut Vec<Mensaje>) {
        self.agregar_extracurricular();
        if self.extra_tema.is_none() {
            out.push(msg(format!(
                "¡Terminamos lo que teníamos para hoy y todavía nos queda tiempo, {}!",
                self.nombre()
            )));
        }
    }

    // ─────────── extracurricular ───────────

    fn sugerencia_interes(&self) -> String {
        self.banco
            .interes_de(&self.perfil.intereses)
            .map(|i| i.sugerencia.clone())
            .unwrap_or_else(|| "los números decimales".into())
    }

    fn preguntar_tema(&mut self, out: &mut Vec<Mensaje>, intentos: u8) {
        let tema = self.tema_principal();
        let max = self.nivel_de(&tema) == Some(self.cfg.niveles_por_tema);
        let s = if max {
            self.sugerencia_interes()
        } else {
            tema.to_lowercase()
        };
        self.aplicar("OBJ-11", "Ya comenzó la sesión: el Alumno elige el tema");
        out.push(msg(format!(
            "¿Qué te gustaría aprender ahora? Te propongo {s}. Por ahora en Matemáticas tengo {}.",
            tema.to_lowercase()
        )));
        self.act = Actividad::ElegirTema { intentos };
    }

    fn elegir_tema(&mut self, t: &str, intentos: u8, out: &mut Vec<Mensaje>) {
        let n = normalizar(t);
        let tema = self.tema_principal();
        let tema_n = normalizar(&tema);
        let raiz = &tema_n[..tema_n.len().min(7)];
        let maximo = self.nivel_de(&tema) == Some(self.cfg.niveles_por_tema);
        if n.contains("terminar")
            || n.contains("ya no")
            || n.contains("nada")
            || texto::es_no(t) && intentos > 0
        {
            out.push(msg("¡Perfecto! Entonces terminamos por hoy."));
            return self.cerrar(out);
        }
        if (n.contains(raiz) || (texto::es_si(t) && !maximo)) && !maximo {
            self.extra_tema = Some(tema.clone());
            self.aplicar("RUT-04", &format!("El Alumno eligió {tema}"));
            out.push(msg(format!("¡Genial! Vamos con {}.", tema.to_lowercase())));
            return self.avanzar(out);
        }
        if n.contains(raiz) && maximo {
            out.push(msg(format!(
                "¡Ya dominas {} hasta el nivel 5! No tengo nada más que enseñarte ahí.",
                tema.to_lowercase()
            )));
        } else {
            // Tema que no está mapeado: honestidad y registro.
            let pedido = t.trim().trim_end_matches(['.', '!']).to_string();
            self.perfil.temas_pedidos.push(pedido.clone());
            self.hechos.push(Hecho::TemaPedido { tema: pedido });
            self.aplicar("OBJ-11", "Tema pedido que no está mapeado: se registra");
            out.push(msg(
                "¡Qué buena idea! Te soy honesto: ese tema todavía no lo tengo preparado. Lo anoto y se lo cuento a tus padres.",
            ));
        }
        if intentos >= 1 || maximo {
            out.push(msg("Por hoy lo dejamos aquí, ¡hiciste un gran trabajo!"));
            return self.cerrar(out);
        }
        out.push(msg(format!(
            "Mientras tanto, ¿te parece si seguimos aprendiendo {}?",
            tema.to_lowercase()
        )));
        self.act = Actividad::ElegirTema {
            intentos: intentos + 1,
        };
    }

    /// RUT-09: ya tiene el nivel 5.
    fn rut09(&mut self, out: &mut Vec<Mensaje>) {
        let tema = self.tema_principal();
        self.aplicar(
            "RUT-09",
            "Ya tiene el nivel 5: felicitar y sugerir otro tema",
        );
        out.push(
            msg(format!(
                "¡Felicitaciones, {}! Ya dominas {} hasta el nivel más alto.",
                self.nombre(),
                tema.to_lowercase()
            ))
            .clase(Clase::Exito),
        );
        if let Some(i) = self.obj_actual {
            if self.objetivos[i].tipo == TipoObjetivo::Extracurricular {
                self.objetivos[i].estado = EstadoObjetivo::Completado;
            }
        }
        self.preguntar_tema(out, 0);
    }

    /// RUT-05 a RUT-08: al llegar al nivel siguiente en extracurricular.
    fn rut05_08(&mut self, out: &mut Vec<Mensaje>) {
        let tema = self.tema_principal();
        let nivel = self.nivel_de(&tema).unwrap_or(0);
        let quedan = nivel < self.cfg.niveles_por_tema;
        let mas_de_30 = self.transcurrido_min() > self.cfg.umbral_extracurricular_min as f64;
        match (quedan, mas_de_30) {
            (true, true) => {
                self.aplicar(
                    "RUT-05",
                    "Quedan niveles y pasaron más de 30 minutos: termina",
                );
                self.completar_extra(out, true)
            }
            (true, false) => {
                self.aplicar(
                    "RUT-06",
                    "Quedan niveles y no pasaron 30 minutos: siguiente nivel",
                );
                self.extra_objetivo = Some(nivel + 1);
                self.avanzar(out)
            }
            (false, true) => {
                self.aplicar(
                    "RUT-07",
                    "No quedan niveles y pasaron más de 30 minutos: termina",
                );
                self.completar_extra(out, true)
            }
            (false, false) => {
                self.aplicar(
                    "RUT-08",
                    "No quedan niveles y no pasaron 30 minutos: preguntar otro tema",
                );
                self.completar_extra(out, false);
                out.push(
                    msg(format!(
                        "¡Lo lograste, {}! Ya dominas todos los niveles de {}.",
                        self.nombre(),
                        tema.to_lowercase()
                    ))
                    .clase(Clase::Exito),
                );
                self.preguntar_tema(out, 0)
            }
        }
    }

    fn completar_extra(&mut self, out: &mut Vec<Mensaje>, cerrar: bool) {
        if let Some(i) = self.obj_actual {
            self.objetivos[i].estado = EstadoObjetivo::Completado;
        }
        self.push_hecho_extra();
        if cerrar {
            self.cerrar(out);
        }
    }

    fn push_hecho_extra(&mut self) {
        if self.extra_tema.is_some()
            && !self
                .hechos
                .iter()
                .any(|h| matches!(h, Hecho::Extracurricular { .. }))
        {
            let tras_objetivo = self.objetivos.iter().any(|o| {
                o.tipo != TipoObjetivo::Extracurricular && o.estado == EstadoObjetivo::Completado
            });
            self.hechos.push(Hecho::Extracurricular {
                curso: self.banco.curso.clone(),
                temas: vec![self.tema_principal()],
                tras_objetivo,
            });
        }
    }

    // ─────────── tamizaje ───────────

    fn pregunta_tamizaje(&self, nivel: u8, usadas: &BTreeSet<String>) -> Ejercicio {
        let n = self.banco.nivel(nivel);
        n.tamizaje
            .iter()
            .find(|e| !usadas.contains(&e.id))
            .unwrap_or(&n.tamizaje[0])
            .clone()
    }

    fn marcar_ruta(&mut self, clave: String, nombre: &str, detalle: String) {
        if self.ruta_hecha.last().map(|x| x.0 != clave).unwrap_or(true) {
            self.ruta_hecha.push((clave, nombre.into(), detalle));
        }
    }

    /// Pasos que faltan para el objetivo (lenguaje del Alumno).
    fn ruta_futura(&self) -> Vec<(String, String)> {
        let oi = match self.obj_actual {
            Some(i) => i,
            None => match self
                .objetivos
                .iter()
                .position(|o| o.estado == EstadoObjetivo::Pendiente)
            {
                Some(i) => i,
                None => return vec![],
            },
        };
        let o = &self.objetivos[oi];
        let tema = self.tema_principal();
        let objetivo = self.nivel_objetivo(oi);
        let mut v: Vec<(String, String)> = vec![];
        // En la pausa, la ruta sigue a la actividad que quedó en pausa.
        let act = match &self.act {
            Actividad::Pausa(p) => p.previa.as_ref(),
            a => a,
        };
        let nivel_tras: Option<u8> = match act {
            Actividad::Tamizaje(_) => None,
            Actividad::Etapa1(e) => {
                v.push(("Refuerzo".into(), format!("Nivel {}", e.nivel)));
                Some(e.nivel)
            }
            Actividad::Etapa2(e) => Some(e.nivel),
            Actividad::Practica(_) => return v,
            _ => {
                if self.nivel_de(&tema).is_none() && o.tipo != TipoObjetivo::Extracurricular {
                    v.push(("Tamizaje".into(), "5 preguntas".into()));
                }
                self.nivel_de(&tema)
            }
        };
        if o.tipo == TipoObjetivo::Extracurricular {
            if let Some(n) = nivel_tras {
                let l = self.extra_objetivo.unwrap_or(n + 1);
                if n < l && l <= self.cfg.niveles_por_tema {
                    v.push(("Descubrimiento".into(), format!("Nivel {l}")));
                    v.push(("Refuerzo".into(), format!("Nivel {l}")));
                }
            }
            return v;
        }
        match nivel_tras {
            None => v.push((
                "Descubrimiento y Refuerzo".into(),
                "según el Tamizaje".into(),
            )),
            Some(n) => {
                for &l in &self.remediacion {
                    if !matches!(act, Actividad::Etapa2(e) if e.nivel == l) {
                        v.push(("Descubrimiento".into(), format!("Nivel {l}")));
                        v.push(("Refuerzo".into(), format!("Nivel {l}")));
                    }
                }
                for l in (n + 1)..=objetivo {
                    v.push(("Descubrimiento".into(), format!("Nivel {l}")));
                    v.push(("Refuerzo".into(), format!("Nivel {l}")));
                }
            }
        }
        if !self.final_hecho {
            let paso = match o.tipo {
                // [PROPUESTA] TAR-08: sin ejercicios hasta el nivel de la foto, no hay paso.
                TipoObjetivo::Tarea => match self.items_tarea(oi).len() {
                    0 => None,
                    n => Some(("Tarea".into(), format!("{n} ejercicios"))),
                },
                TipoObjetivo::Preparacion => Some(("Simulación".into(), "como un examen".into())),
                TipoObjetivo::Correccion => Some(("Corrección".into(), "lo que salió mal".into())),
                TipoObjetivo::Extracurricular => unreachable!(),
            };
            v.extend(paso);
        }
        v
    }

    pub fn ruta(&self) -> Vec<PasoRuta> {
        let paso = |n: &str, d: &str, e: &str| PasoRuta {
            nombre: n.into(),
            detalle: d.into(),
            estado: e.into(),
        };
        let mut v: Vec<PasoRuta> = vec![];
        let en_curso = matches!(
            &self.act,
            Actividad::Tamizaje(_)
                | Actividad::Etapa1(_)
                | Actividad::Etapa2(_)
                | Actividad::Practica(_)
                | Actividad::Pausa(_)
        );
        let k = self.ruta_hecha.len();
        for (i, (_, n, d)) in self.ruta_hecha.iter().enumerate() {
            let actual = en_curso && i + 1 == k;
            v.push(paso(n, d, if actual { "actual" } else { "hecho" }));
        }
        if !self.terminada() {
            for (n, d) in self.ruta_futura() {
                v.push(paso(&n, &d, "pendiente"));
            }
        }
        v
    }

    fn iniciar_tamizaje(&mut self, tema: &str, out: &mut Vec<Mensaje>) {
        self.marcar_ruta("tamizaje".into(), "Tamizaje", "5 preguntas".into());
        let parcial = self.perfil.tamizaje_parcial.remove(tema);
        let (respuestas, nivel, usadas) = match parcial {
            Some(p) => {
                let r: Vec<(u8, bool)> = p
                    .respuestas
                    .into_iter()
                    .filter(|(n, _)| *n < p.retomar_en)
                    .collect();
                self.aplicar(
                    "TAM-06",
                    &format!(
                        "Se retoma el Tamizaje en el nivel {} con otra pregunta",
                        p.retomar_en
                    ),
                );
                out.push(msg(format!(
                    "La vez pasada empezamos el Tamizaje y nos quedamos en la pregunta {}. Hoy la retomamos con una pregunta nueva. Tranquilo, con calma.",
                    p.retomar_en
                )).clase(Clase::Calma));
                (r, p.retomar_en, p.usadas)
            }
            None => {
                self.aplicar("TAM-01", "Nivel desconocido: Tamizaje (1 vez por tema)");
                // [PROPUESTA] Antes de empezar, el Alumno oye para qué es el
                // calentamiento, según el objetivo de la sesión.
                let para = match self.obj_actual.map(|i| self.objetivos[i].tipo) {
                    Some(TipoObjetivo::Tarea) => {
                        "Para ayudarte a resolver tu tarea de la mejor forma"
                    }
                    Some(TipoObjetivo::Preparacion) => "Para prepararte bien para tu evaluación",
                    _ => "Para saber desde dónde empezar",
                };
                out.push(msg(format!(
                    "{para}, vamos a hacer algunos ejercicios de calentamiento: son {} preguntas, de la más fácil a la más difícil. En cada una dime tu respuesta y cómo lo pensaste.",
                    self.cfg.niveles_por_tema
                )));
                out.push(
                    msg("Aquí no hay pistas y equivocarse está bien: quiero ver cómo piensas tú.")
                        .clase(Clase::Calma),
                );
                (vec![], 1, BTreeSet::new())
            }
        };
        let actual = self.pregunta_tamizaje(nivel, &usadas);
        let mut usadas = usadas;
        usadas.insert(actual.id.clone());
        self.act = Actividad::Tamizaje(Box::new(Tam {
            tema: tema.into(),
            nivel,
            respuestas,
            actual,
            usadas,
        }));
        self.presentar(out, true);
    }

    /// TAM-03: último nivel consecutivo correcto desde el nivel 1.
    pub fn ultimo_consecutivo(respuestas: &[(u8, bool)]) -> u8 {
        let mut ordenadas = respuestas.to_vec();
        ordenadas.sort_by_key(|(n, _)| *n);
        let mut nivel = 0;
        for (n, ok) in ordenadas {
            if ok && n == nivel + 1 {
                nivel = n;
            } else {
                break;
            }
        }
        nivel
    }

    fn calificar_tamizaje(&mut self, mut tam: Box<Tam>, c: Calificacion, out: &mut Vec<Mensaje>) {
        if c.ilegible {
            out.push(msg(
                "No te entendí la respuesta. ¿Me la repites? Por ejemplo: «tres cuartos».",
            ));
            self.act = Actividad::Tamizaje(tam);
            return;
        }
        // TAM-04: correcta solo si la respuesta y la explicación están bien.
        let ok = c.respuesta_correcta && c.explicacion_correcta.unwrap_or(false);
        self.aplicar(
            "TAM-04",
            &format!(
                "Tamizaje nivel {}: respuesta {} · explicación {} → {}",
                tam.nivel,
                si_no(c.respuesta_correcta),
                si_no(c.explicacion_correcta.unwrap_or(false)),
                if ok { "correcta" } else { "incorrecta" }
            ),
        );
        tam.respuestas.retain(|(n, _)| *n != tam.nivel);
        tam.respuestas.push((tam.nivel, ok));
        let calma = self.rota(&CALMA).to_string();
        if tam.nivel >= self.cfg.niveles_por_tema {
            out.push(msg("¡Gracias! Esa era la última pregunta del Tamizaje."));
            return self.terminar_tamizaje(*tam, true, out);
        }
        out.push(msg(format!("¡Gracias! Lo anoto. {calma}")).clase(Clase::Calma));
        tam.nivel += 1;
        tam.actual = self.pregunta_tamizaje(tam.nivel, &tam.usadas);
        tam.usadas.insert(tam.actual.id.clone());
        self.cupo_descontar();
        self.act = Actividad::Tamizaje(tam);
        if self.frontera(out) {
            return;
        }
        self.presentar(out, true);
    }

    fn terminar_tamizaje(&mut self, tam: Tam, completo: bool, out: &mut Vec<Mensaje>) {
        let nivel = Self::ultimo_consecutivo(&tam.respuestas);
        self.perfil.niveles.insert(tam.tema.clone(), nivel);
        self.aplicar(
            "TAM-03",
            &format!("Queda en el último nivel consecutivo correcto: {nivel}"),
        );
        if completo {
            self.plan_pendiente = Some((tam.tema.clone(), nivel));
        }
        // [PROPUESTA] TAR-05: con la foto de la Tarea por ver, el Nivel objetivo
        // todavía no se conoce: el plan se registra y se cuenta después de verla.
        if self.obj_actual.is_some_and(|oi| self.foto_por_pedir(oi)) {
            self.aplicar("TAR-05", "El plan espera a la foto de la Tarea");
            out.push(msg(
                "¡Terminamos el calentamiento! Gracias por pensar conmigo.",
            ));
            return self.avanzar(out);
        }
        self.registrar_plan();
        // [PROPUESTA] Por debajo del Nivel objetivo, el cierre es el plan. Sin
        // ningún nivel, con el 5 o con el objetivo ya alcanzado, el de siempre.
        if nivel == 0 || !self.decir_plan(nivel, out) {
            let texto = match nivel {
                0 => "¡Terminamos el Tamizaje! Ya sé por dónde empezar: vamos a construir las fracciones desde el principio, paso a paso.".to_string(),
                n if n >= self.cfg.niveles_por_tema => "¡Terminamos el Tamizaje! Resolviste todo muy bien.".to_string(),
                n => format!(
                    "¡Terminamos el Tamizaje! Ya sé por dónde empezar: lo del nivel {n} ya lo manejas, así que seguimos desde ahí."
                ),
            };
            out.push(msg(texto).ia(
                "Cierra el Tamizaje con calidez en 1 o 2 frases: agradece el esfuerzo y di que ya sabes por dónde empezar. No menciones respuestas correctas ni incorrectas.",
            ));
        }
        self.avanzar(out);
    }

    /// TAM-08 / PRE-02: el resultado del Tamizaje que terminó y el plan hasta el
    /// Nivel objetivo van en el Informe.
    fn registrar_plan(&mut self) {
        let Some((tema, nivel)) = self.plan_pendiente.take() else {
            return;
        };
        let (hecho, plan) = self.resultado_tamizaje(tema, nivel);
        if let Some((niveles, sesiones)) = plan {
            self.estimacion_sesiones = Some(sesiones);
            self.aplicar(
                "PRE-02",
                &format!("Plan: {niveles} niveles → {sesiones} sesiones"),
            );
        }
        self.hechos.push(hecho);
        self.aplicar("TAM-08", "Resultado y plan van en el Informe");
    }

    /// TAM-08: lo que dice el Informe de un Tamizaje que dejó al Alumno en
    /// `nivel`, y el plan (niveles y sesiones, PRE-02) cuando hay que reforzar.
    fn resultado_tamizaje(&self, tema: String, nivel: u8) -> (Hecho, Option<(u8, u32)>) {
        let curso = self.banco.curso.clone();
        let objetivo = self
            .obj_actual
            .map(|i| self.nivel_objetivo(i))
            .filter(|_| {
                self.obj_actual
                    .map(|i| self.objetivos[i].tipo != TipoObjetivo::Extracurricular)
                    .unwrap_or(false)
            })
            .unwrap_or(self.cfg.niveles_por_tema);
        if nivel >= objetivo {
            return (Hecho::TamizajeSinMejora { curso, tema, nivel }, None);
        }
        let faltan: Vec<String> = ((nivel + 1)..=objetivo)
            .map(|l| self.banco.subtema(l).to_string())
            .collect();
        let sesiones = self.estimar_sesiones(objetivo - nivel);
        let hecho = Hecho::Tamizaje {
            curso,
            temas_mejora: faltan,
            tema,
            sesiones,
            comienzo: "hoy mismo".into(),
        };
        (hecho, Some((objetivo - nivel, sesiones)))
    }

    /// [PROPUESTA] Le cuenta al Alumno qué vamos a reforzar antes del objetivo,
    /// en el orden en que lo veremos, y para qué. Devuelve si había algo que
    /// reforzar. Va aparte para poder decirlo también en otro momento, por
    /// ejemplo después de ver la Tarea.
    fn decir_plan(&mut self, nivel: u8, out: &mut Vec<Mensaje>) -> bool {
        let Some(oi) = self.obj_actual else {
            return false;
        };
        let tipo = self.objetivos[oi].tipo;
        // Hasta el Nivel objetivo (RUT-03); en extracurricular, el nivel siguiente (RUT-04).
        let hasta = match tipo {
            TipoObjetivo::Extracurricular => self
                .extra_objetivo
                .unwrap_or(nivel + 1)
                .min(self.cfg.niveles_por_tema),
            _ => self.nivel_objetivo(oi),
        };
        let niveles: Vec<u8> = ((nivel + 1)..=hasta).collect();
        if niveles.is_empty() {
            return false;
        }
        let nombres: Vec<String> = niveles
            .iter()
            .map(|l| self.banco.nivel(*l).nombre_corto.clone())
            .collect();
        let temas = lista(&nombres);
        let texto = match tipo {
            TipoObjetivo::Tarea => format!(
                "He analizado cómo te fue en los ejercicios, y antes de que hagamos la tarea, te voy a ayudar a reforzar {temas}. Esto es importante para que aprendas a hacer la tarea por tu cuenta."
            ),
            TipoObjetivo::Preparacion => format!(
                "He analizado cómo te fue en los ejercicios, y antes de que simulemos tu evaluación, te voy a ayudar a reforzar {temas}. Esto es importante para que en tu evaluación puedas resolver todo por tu cuenta."
            ),
            TipoObjetivo::Correccion => format!(
                "He analizado cómo te fue en los ejercicios, y antes de que revisemos tu evaluación, te voy a ayudar a reforzar {temas}. Esto es importante para que puedas resolver por tu cuenta las preguntas que te salieron mal."
            ),
            TipoObjetivo::Extracurricular => format!(
                "He analizado cómo te fue en los ejercicios, y ya sé desde dónde empezar: te voy a ayudar a aprender {temas}."
            ),
        };
        let numeros: Vec<String> = niveles.iter().map(|l| l.to_string()).collect();
        self.aplicar(
            "TAM-08",
            &format!(
                "Plan contado al Alumno: niveles {} antes del objetivo",
                lista(&numeros)
            ),
        );
        out.push(msg(texto));
        self.plan_dicho = niveles;
        true
    }

    fn salir_tamizaje(&mut self, out: &mut Vec<Mensaje>) {
        let Actividad::Tamizaje(tam) = self.act.clone() else {
            return;
        };
        // TAM-06: queda en el último nivel consecutivo correcto; se retoma después.
        let hubo_fallo = tam.respuestas.iter().any(|(_, ok)| !ok);
        out.push(
            msg("Está perfecto, gracias por decirme. Dejamos el Tamizaje aquí y lo retomamos otro día con calma.")
                .clase(Clase::Calma),
        );
        if hubo_fallo {
            self.aplicar(
                "TAM-06",
                "Salió del Tamizaje después de un fallo: el nivel ya quedó definido",
            );
            return self.terminar_tamizaje(*tam, true, out);
        }
        let retomar = tam.respuestas.iter().map(|(n, _)| *n).max().unwrap_or(1);
        let nivel = Self::ultimo_consecutivo(&tam.respuestas);
        self.aplicar(
            "TAM-06",
            &format!("Salió del Tamizaje: queda en nivel {nivel}, se retoma en el nivel {retomar}"),
        );
        self.perfil.tamizaje_parcial.insert(
            tam.tema.clone(),
            TamizajeParcial {
                respuestas: tam.respuestas.clone(),
                retomar_en: retomar,
                usadas: tam.usadas.clone(),
            },
        );
        self.tamizaje_salido_hoy.insert(tam.tema.clone());
        self.hechos.push(Hecho::TamizajeIncompleto {
            curso: self.banco.curso.clone(),
            tema: tam.tema.clone(),
            proxima: self.perfil.proxima_sesion,
        });
        self.perfil.niveles.insert(tam.tema.clone(), nivel);
        self.avanzar(out);
    }

    fn estimar_sesiones(&self, niveles: u8) -> u32 {
        // PRE-02 / MET-05: niveles × tiempo promedio por nivel; sin historial 1 nivel por sesión.
        let h: Vec<f64> = self.perfil.time_to_master.iter().map(|x| x.2).collect();
        let por_nivel = if h.is_empty() {
            self.cfg.minutos_por_nivel_inicial as f64
        } else {
            h.iter().sum::<f64>() / h.len() as f64
        };
        ((niveles as f64 * por_nivel) / self.cfg.minutos_por_sesion_plan as f64)
            .ceil()
            .max(1.0) as u32
    }

    // ─────────── foto de la Tarea (TAR-05 a TAR-07) ───────────

    /// [PROPUESTA] TAR-05: hay que ver la Tarea del objetivo `oi` para saber su
    /// nivel. Si quien presenta ya cargó el Nivel objetivo (OBJ-06), no.
    fn foto_por_pedir(&self, oi: usize) -> bool {
        let o = &self.objetivos[oi];
        self.cfg.foto_tarea
            && o.tipo == TipoObjetivo::Tarea
            && o.nivel_objetivo.is_none()
            && self.foto == EstadoFoto::Pendiente
    }

    /// [PROPUESTA] TAR-05: pide ver la Tarea a la cámara; `nivel` es el del Alumno.
    fn pedir_foto_tarea(&mut self, nivel: u8, out: &mut Vec<Mensaje>) {
        // El Tamizaje de hoy terminó con el plan en espera, o se dejó a medias.
        let tras_tamizaje = self.plan_pendiente.is_some() || !self.tamizaje_salido_hoy.is_empty();
        self.aplicar(
            "TAR-05",
            "Se pide la foto de la Tarea: su nivel será el Nivel objetivo (OBJ-07)",
        );
        self.act = Actividad::PedirTarea {
            nivel,
            intentos: 0,
            charlas: 0,
            tras_tamizaje,
        };
        self.presentar(out, true);
    }

    /// [PROPUESTA] TAR-06: lo que dice el Alumno mientras se espera la foto.
    fn texto_pedir_tarea(&mut self, t: &str, out: &mut Vec<Mensaje>) {
        let Actividad::PedirTarea { nivel, charlas, .. } = self.act else {
            return;
        };
        if no_tiene_tarea(t) {
            self.aplicar("TAR-06", "Dijo que no tiene la Tarea: se sigue sin la foto");
            out.push(msg("¡No pasa nada!"));
            return self.seguir_sin_foto(nivel, out);
        }
        let charlas = charlas.saturating_add(1);
        if charlas >= self.cfg.charlas_sin_foto {
            self.aplicar(
                "TAR-06",
                &format!("{charlas} turnos de conversación sin foto: se sigue sin ella"),
            );
            out.push(msg("No te preocupes, seguimos sin la foto."));
            return self.seguir_sin_foto(nivel, out);
        }
        if let Actividad::PedirTarea { charlas: c, .. } = &mut self.act {
            *c = charlas;
        }
        out.push(msg(
            "Te escucho. Cuando la tengas, muéstrame tu tarea a la cámara; si no la tienes, dime «no tengo».",
        ));
    }

    /// [PROPUESTA] TAR-05 y TAR-06: lo que se leyó en la foto de la Tarea.
    fn foto_tarea(&mut self, lectura: LecturaTarea, out: &mut Vec<Mensaje>) {
        let Actividad::PedirTarea {
            nivel, intentos, ..
        } = self.act
        else {
            // Nadie pidió una foto.
            return;
        };
        // Un nivel que el tema no tiene es una lectura que falló; una lectura
        // poco segura es una foto que no se vio bien.
        let lectura = match lectura {
            LecturaTarea::Leida { nivel: n, .. }
                if !self.banco.niveles.iter().any(|x| x.nivel == n) =>
            {
                LecturaTarea::NoDisponible
            }
            LecturaTarea::Leida { confianza, .. } if confianza < self.cfg.confianza_minima_foto => {
                LecturaTarea::Borrosa
            }
            otra => otra,
        };
        let (otra_vez, por_que) = match lectura {
            LecturaTarea::Leida { nivel: n, .. } => return self.foto_leida(n, nivel, out),
            LecturaTarea::OtroTema => {
                // TAR-07 / OBJ-08: lo que no cubrimos se dice con honestidad y se registra.
                let tema = self.banco.tema.to_lowercase();
                self.aplicar(
                    "TAR-07",
                    "La Tarea no es del tema: se le cuenta a la familia y se sigue sin la foto",
                );
                self.hechos.push(Hecho::TareaOtroTema {
                    tema: self.banco.tema.clone(),
                });
                out.push(msg(format!(
                    "Esa tarea no es de {tema}, y por ahora yo solo sé enseñar {tema}. Se lo cuento a tu familia."
                )));
                return self.seguir_sin_foto(nivel, out);
            }
            LecturaTarea::Borrosa => (
                "Uy, no la pude ver bien. Acércala un poquito a la cámara, con buena luz, y muéstramela otra vez.",
                "no se ve bien",
            ),
            LecturaTarea::SinTarea => (
                "Mmm, no veo una tarea en la foto. ¿Me la muestras otra vez? Si no la tienes, dime «no tengo».",
                "no se ve una Tarea",
            ),
            LecturaTarea::NoDisponible => (
                "Uy, no pude mirar la foto. ¿Probamos otra vez?",
                "no se pudo mirar",
            ),
        };
        let intentos = intentos.saturating_add(1);
        if intentos >= self.cfg.intentos_foto {
            self.aplicar(
                "TAR-06",
                &format!("{intentos} fotos sin leer ({por_que}): se sigue sin la foto"),
            );
            out.push(msg("No te preocupes, seguimos sin la foto."));
            return self.seguir_sin_foto(nivel, out);
        }
        self.aplicar("TAR-06", &format!("La foto {por_que}: se pide otra"));
        if let Actividad::PedirTarea { intentos: i, .. } = &mut self.act {
            *i = intentos;
        }
        out.push(msg(otra_vez));
    }

    /// [PROPUESTA] TAR-05: la Tarea es del nivel `n`, que pasa a ser el Nivel
    /// objetivo. Recién ahora el plan va al Informe y se le cuenta al Alumno,
    /// que está en `nivel`.
    fn foto_leida(&mut self, n: u8, nivel: u8, out: &mut Vec<Mensaje>) {
        let Some(oi) = self.obj_actual else {
            return;
        };
        self.objetivos[oi].nivel_objetivo = Some(n);
        self.foto = EstadoFoto::Leida { nivel: n };
        self.aplicar(
            "TAR-05",
            &format!("La Tarea de la foto es del nivel {n}: es el Nivel objetivo"),
        );
        self.hechos.push(Hecho::TareaVista {
            curso: self.banco.curso.clone(),
            subtema: self.banco.subtema(n).to_string(),
        });
        out.push(msg(format!(
            "¡Gracias! Ya vi tu tarea: es de {}.",
            self.banco.nivel(n).nombre_corto
        )));
        self.registrar_plan();
        // Sin nada que reforzar, a la Tarea; si la del banco no tiene ejercicios
        // hasta ese nivel, no hay a dónde ir directo (TAR-08).
        if !self.decir_plan(nivel, out) && !self.items_tarea(oi).is_empty() {
            out.push(msg("¡Eso ya lo sabes hacer! Vamos directo a tu tarea."));
        }
        self.avanzar(out);
    }

    /// [PROPUESTA] TAR-07: sin la foto, como hasta ahora: los ejercicios y el
    /// nivel de la Tarea del banco. El Alumno está en `nivel`.
    fn seguir_sin_foto(&mut self, nivel: u8, out: &mut Vec<Mensaje>) {
        self.foto = EstadoFoto::SinFoto;
        self.aplicar("TAR-07", "Sin la foto: la Tarea del banco, con su nivel");
        out.push(msg(format!(
            "Vamos a practicar con ejercicios míos, como los de una tarea de {}.",
            self.banco.tema.to_lowercase()
        )));
        self.registrar_plan();
        self.decir_plan(nivel, out);
        self.avanzar(out);
    }

    /// [PROPUESTA] TAR-05: lo que se le recuerda al Alumno cuando el motor espera
    /// algo que no está en pantalla, por ejemplo al volver a conectarse: hoy, la
    /// foto de su Tarea.
    pub fn recordatorio(&self) -> Option<String> {
        match self.act {
            Actividad::PedirTarea { tras_tamizaje, .. } => {
                Some(pedir_tarea(tras_tamizaje).to_string())
            }
            _ => None,
        }
    }

    // ─────────── Etapa 1 ───────────

    fn iniciar_e1(&mut self, nivel: u8, out: &mut Vec<Mensaje>) {
        // Lo mínimo para que valga la pena empezar: la Etapa 1 y 3 ejercicios de la Etapa 2.
        let ritmo = self.cfg.factor_tiempo * self.factor_ritmo();
        let prom_ej = {
            let n = self.banco.nivel(nivel);
            n.ejercicios.iter().map(|e| e.tiempo_s as f64).sum::<f64>()
                / n.ejercicios.len().max(1) as f64
        };
        let necesario =
            (self.cfg.etapa1_min_estimados as f64 * 60.0 + 3.0 * prom_ej) * ritmo / 60.0;
        if self.cupo.is_some()
            || self.transcurrido_min() + necesario > self.cfg.sesion_maxima_min as f64
        {
            // SES-06: no se empieza un tema nuevo que no alcanza a terminar hoy.
            self.aplicar(
                "SES-06",
                "No alcanza el tiempo para una Etapa 1 nueva: se cierra y se retoma la próxima sesión",
            );
            out.push(msg(format!(
                "{}, ya estamos llegando al final de la sesión, así que este tema nuevo lo empezamos en la próxima.",
                self.nombre()
            )).clase(Clase::Aviso));
            self.aviso_dado = true;
            self.pila.clear();
            return self.cerrar(out);
        }
        let n = self.nivel_c(nivel);
        self.marcar_ruta(
            format!("e1-{nivel}"),
            "Descubrimiento",
            format!("Nivel {nivel}"),
        );
        let activo = self.activo_ms();
        self.ttm_inicio.entry(nivel).or_insert(activo);
        self.aplicar(
            "E1-01",
            &format!("Etapa 1: Descubrimiento del nivel {nivel}"),
        );
        let vuelta = {
            let v = self.e1_vueltas.entry(nivel).or_insert(0);
            *v += 1;
            *v
        };
        if vuelta > MAX_VUELTAS_E1 {
            // [PROPUESTA] E2-04 devuelve a la Etapa 1 sin límite; una tercera
            // vuelta el mismo día repite lo que ya no funcionó dos veces.
            self.aplicar(
                "E2-04",
                &format!(
                    "Tercera vuelta a la Etapa 1 del nivel {nivel}: se deja para la próxima sesión"
                ),
            );
            out.push(msg(format!(
                "Hoy trabajaste mucho {}, {}. Lo dejamos aquí y lo seguimos la próxima vez, con calma y de otra manera.",
                n.titulo.to_lowercase(),
                self.nombre()
            )).clase(Clase::Calma));
            self.cerrar(out);
            return;
        }
        let plan = std::mem::take(&mut self.plan_dicho);
        if vuelta == 1 {
            // [PROPUESTA] Recién contado el plan, su primer nivel no se presenta
            // como algo nuevo: se empieza por lo que el Alumno acaba de oír.
            let texto = match plan.first() {
                Some(&l) if l == nivel && plan.len() > 1 => {
                    format!("Etapa 1: Descubrimiento. Empecemos por {}.", n.nombre_corto)
                }
                Some(&l) if l == nivel => "Etapa 1: Descubrimiento. ¡Empecemos!".to_string(),
                _ => format!(
                    "Etapa 1: Descubrimiento. Vamos a aprender algo nuevo: {}.",
                    n.titulo.to_lowercase()
                ),
            };
            out.push(msg(texto));
        } else {
            out.push(msg(format!(
                "Etapa 1: Descubrimiento, otra vez: {}. Esta vez te lo cuento de otra forma.",
                n.titulo.to_lowercase()
            )));
        }
        self.act = Actividad::Etapa1(E1 {
            nivel,
            fase: FaseE1::Teoria(0),
        });
        self.presentar(out, true);
    }

    /// [PROPUESTA] Cierra una explicación o un ejemplo resuelto con la pregunta
    /// que dice cómo se sigue, y empieza de cero la cuenta de conversación.
    fn preguntar_si_seguimos(&mut self, out: &mut Vec<Mensaje>) {
        self.charlas_explicacion = 0;
        out.push(msg(SEGUIMOS));
    }

    /// De una explicación o un ejemplo resuelto a lo que sigue: la siguiente
    /// explicación, el siguiente ejemplo o el primer ejemplo acompañado.
    fn seguir_e1(&mut self, mut e1: E1, out: &mut Vec<Mensaje>) {
        let c = self.nivel_c(e1.nivel);
        e1.fase = match e1.fase {
            FaseE1::Teoria(i) if i + 1 < c.etapa1.teoria.len() => FaseE1::Teoria(i + 1),
            FaseE1::Teoria(_) => FaseE1::NoAsistido(0),
            FaseE1::NoAsistido(i) if i + 1 < c.etapa1.no_asistidos.len() => {
                FaseE1::NoAsistido(i + 1)
            }
            FaseE1::NoAsistido(_) => FaseE1::Asistido {
                ej: 0,
                paso: 0,
                fallos: 0,
                limpio: true,
            },
            otra => otra,
        };
        self.act = Actividad::Etapa1(e1);
        if self.frontera_suave(out) {
            return;
        }
        self.presentar(out, true);
    }

    fn texto_e1(&mut self, e1: E1, t: &str, out: &mut Vec<Mensaje>) {
        let n = normalizar(t);
        let no_entendi = n.contains("no entend")
            || n.contains("otra vez")
            || n.contains("repite")
            || n.contains("no comprend")
            // «¿Seguimos?» · «No»: se le explica otra vez.
            || n == "no";
        let pregunta = t.contains('?')
            || ["que ", "como ", "por que", "porque ", "cual ", "cuando "]
                .iter()
                .any(|p| n.starts_with(p));
        let c = self.nivel_c(e1.nivel);
        match e1.fase.clone() {
            FaseE1::Teoria(i) => {
                if no_entendi {
                    let b = &c.etapa1.teoria[i];
                    out.push(
                        msg(format!("Vamos de nuevo, despacito: {}", b.texto))
                            .clase(Clase::Teoria)
                            .ia(format!(
                                "El Alumno no entendió esta parte de la teoría. Explícala de otra forma, más simple, en máximo 3 frases cortas, con un ejemplo de sus intereses. No cambies los números. Texto original: \"{}\"",
                                b.texto
                            )),
                    );
                    self.preguntar_si_seguimos(out);
                    self.act = Actividad::Etapa1(e1);
                    return;
                }
                if pregunta {
                    out.push(
                        msg("¡Buena pregunta! Sigamos y lo vas a ver en los ejemplos.")
                            .ia(format!(
                                "El Alumno hizo una pregunta durante la teoría de \"{}\". Respóndela en máximo 3 frases cortas y correctas. Luego pregunta si seguimos. Pregunta: \"{}\"",
                                c.titulo, t
                            )),
                    );
                    self.preguntar_si_seguimos(out);
                    self.act = Actividad::Etapa1(e1);
                    return;
                }
                self.seguir_e1(e1, out);
            }
            FaseE1::NoAsistido(i) => {
                if no_entendi || pregunta {
                    let ej = &c.etapa1.no_asistidos[i];
                    out.push(
                        msg("Mira otra vez cada paso con calma. Fíjate qué cambia en cada uno.")
                            .ia(format!(
                                "El Alumno no entendió un ejemplo resuelto. Explica de nuevo, más simple, en máximo 4 frases cortas, la idea de los pasos sin cambiar los números. Ejemplo: \"{}\" Pasos: {}. Lo que dijo: \"{}\"",
                                ej.enunciado,
                                ej.pasos.join(" | "),
                                t
                            )),
                    );
                    self.preguntar_si_seguimos(out);
                    self.act = Actividad::Etapa1(e1);
                    return;
                }
                self.seguir_e1(e1, out);
            }
            FaseE1::Asistido { .. } => {
                self.act = Actividad::Etapa1(e1);
                self.texto_lateral(t, out);
            }
            FaseE1::Explicar { .. } => {
                // La capa web normalmente envía la explicación ya juzgada; si llega
                // como texto, se juzga con el respaldo de palabras clave.
                let ok = crate::correccion::explicacion_por_claves(
                    t,
                    &c.etapa1.explicar.claves,
                    c.etapa1.explicar.minimo_claves,
                );
                self.act = Actividad::Etapa1(e1);
                self.calificada(
                    Calificacion {
                        respuesta_correcta: ok,
                        explicacion_correcta: Some(ok),
                        ..Default::default()
                    },
                    out,
                );
            }
        }
    }

    fn calificar_e1(&mut self, mut e1: E1, c: Calificacion, ayuda: bool, out: &mut Vec<Mensaje>) {
        let cont = self.nivel_c(e1.nivel);
        match e1.fase.clone() {
            FaseE1::Asistido {
                ej, paso, fallos, ..
            } => {
                let ejemplo = &cont.etapa1.asistidos[ej];
                let p = &ejemplo.pasos[paso];
                if !ayuda && c.ilegible {
                    out.push(msg("No te entendí la respuesta. ¿Me la repites?"));
                    self.act = Actividad::Etapa1(e1);
                    return;
                }
                if !ayuda && c.respuesta_correcta {
                    let e = self.rota(&EXITO).to_string();
                    out.push(msg(e).clase(Clase::Exito));
                    self.siguiente_paso_asistido(e1, ej, paso, out);
                    return;
                }
                if fallos == 0 {
                    let pre = if ayuda {
                        "Te ayudo:"
                    } else {
                        "Casi. Pensemos juntos:"
                    };
                    out.push(msg(format!("{pre} {}", p.ayuda)).clase(Clase::Pista));
                    // Una pista o un error: este ejemplo ya no salió limpio.
                    e1.fase = FaseE1::Asistido {
                        ej,
                        paso,
                        fallos: 1,
                        limpio: false,
                    };
                    self.act = Actividad::Etapa1(e1);
                } else {
                    out.push(
                        msg(format!("Mira cómo se hace este paso: {}", p.solucion))
                            .clase(Clase::Pista),
                    );
                    self.siguiente_paso_asistido(e1, ej, paso, out);
                }
            }
            FaseE1::Explicar {
                pistas,
                repaso_hecho,
            } => {
                let ex = &cont.etapa1.explicar;
                if !ayuda && c.respuesta_correcta {
                    self.aplicar(
                        "E1-04",
                        "Explicó con sus palabras y concluyó los 2 tipos de ejemplos",
                    );
                    out.push(
                        msg(c.comentario.clone().unwrap_or_else(|| {
                            "¡Muy bien explicado! Se nota que lo entendiste.".into()
                        }))
                        .clase(Clase::Exito),
                    );
                    self.e1_lista = Some(e1.nivel);
                    return self.avanzar(out);
                }
                if !ayuda {
                    if let Some(com) = c.comentario.clone() {
                        out.push(msg(com));
                    }
                }
                // E1-05: misma secuencia de pistas; si las agota, repaso conceptual.
                let orden = self.cfg.orden_pistas.clone();
                if pistas < orden.len() {
                    let socr_previas = orden[..pistas]
                        .iter()
                        .filter(|t| **t == TipoPista::Socratica)
                        .count();
                    self.aplicar(
                        "E1-05",
                        &format!("No logró explicarlo: pista {}", pistas + 1),
                    );
                    let m = match orden[pistas] {
                        TipoPista::Socratica => msg(ex
                            .pistas
                            .get(socr_previas)
                            .cloned()
                            .unwrap_or_else(|| ex.pregunta.clone())),
                        TipoPista::Grafica => {
                            msg(ex.pista_grafica.texto.clone()).adj(Adjunto::Grafico {
                                grafico: ex.pista_grafica.grafico.clone(),
                            })
                        }
                    };
                    out.push(m.clase(Clase::Pista));
                    out.push(msg("Ahora, con tus palabras, inténtalo otra vez."));
                    e1.fase = FaseE1::Explicar {
                        pistas: pistas + 1,
                        repaso_hecho,
                    };
                    self.act = Actividad::Etapa1(e1);
                    return;
                }
                if !repaso_hecho {
                    self.aplicar("E1-05", "Agotó las pistas: repaso conceptual");
                    out.push(msg("Hagamos un repaso con calma. Esto le pasa a todos cuando aprenden algo nuevo.").clase(Clase::Calma));
                    for b in &ex_repaso(&cont) {
                        let mut m = msg(b.texto.clone()).clase(Clase::Teoria);
                        if let Some(g) = &b.grafico {
                            m = m.adj(Adjunto::Grafico { grafico: g.clone() });
                        }
                        out.push(m);
                    }
                    out.push(msg(format!("Ahora sí: {}", ex.pregunta)));
                    e1.fase = FaseE1::Explicar {
                        pistas,
                        repaso_hecho: true,
                    };
                    self.act = Actividad::Etapa1(e1);
                    return;
                }
                // Decisión: tras el repaso no se bloquea; la Etapa 2 lo reforzará.
                self.aplicar(
                    "E1-05",
                    "Después del repaso sigue a la Etapa 2 (la práctica termina de asentarlo)",
                );
                out.push(
                    msg("Lo vas a entender cada vez mejor con la práctica. ¡Vamos a practicar!")
                        .clase(Clase::Calma),
                );
                self.e1_lista = Some(e1.nivel);
                self.avanzar(out);
            }
            _ => {
                self.act = Actividad::Etapa1(e1);
                if ayuda {
                    out.push(msg(
                        "Aquí estoy mirando contigo. Si algo no se entiende, dime «no entendí» y te lo explico de otra forma.",
                    ));
                }
            }
        }
    }

    fn siguiente_paso_asistido(
        &mut self,
        mut e1: E1,
        ej: usize,
        paso: usize,
        out: &mut Vec<Mensaje>,
    ) {
        let cont = self.nivel_c(e1.nivel);
        let ejemplo = &cont.etapa1.asistidos[ej];
        let limpio = matches!(e1.fase, FaseE1::Asistido { limpio: true, .. });
        if paso + 1 < ejemplo.pasos.len() {
            e1.fase = FaseE1::Asistido {
                ej,
                paso: paso + 1,
                fallos: 0,
                limpio,
            };
        } else {
            out.push(
                msg(format!(
                    "¡Lo resolviste tú! El resultado es {}.",
                    ejemplo.respuesta
                ))
                .clase(Clase::Exito),
            );
            let queda_otro = ej + 1 < cont.etapa1.asistidos.len();
            // [PROPUESTA] Todos los pasos bien al primer intento y sin pistas: ya
            // sabe ejecutarlos, así que pasa a explicarlo sin el ejemplo siguiente.
            if queda_otro && limpio {
                self.aplicar(
                    "E1-03",
                    &format!(
                        "Ejemplo guiado {} sin errores ni pistas: pasa a explicarlo, sin el siguiente",
                        ej + 1
                    ),
                );
            }
            e1.fase = if queda_otro && !limpio {
                FaseE1::Asistido {
                    ej: ej + 1,
                    paso: 0,
                    fallos: 0,
                    limpio: true,
                }
            } else {
                FaseE1::Explicar {
                    pistas: 0,
                    repaso_hecho: false,
                }
            };
            self.act = Actividad::Etapa1(e1);
            if self.frontera_suave(out) {
                return;
            }
            return self.presentar(out, true);
        }
        self.act = Actividad::Etapa1(e1);
        self.presentar(out, true);
    }

    // ─────────── Etapa 2 ───────────

    fn elegir_e2(&mut self, nivel: u8) -> Vec<Ejercicio> {
        // E2-01: 5 ejercicios desde diferentes ángulos (uno por ángulo).
        let n = self.banco.nivel(nivel);
        let mut lista = vec![];
        for a in crate::banco::Angulo::ORDEN_PRACTICA {
            let cands: Vec<&Ejercicio> = n
                .ejercicios
                .iter()
                .filter(|e| e.angulo == Some(a))
                .collect();
            let e = cands
                .iter()
                .find(|e| !self.perfil.ejercicios_usados.contains(&e.id))
                .or(cands.first())
                .map(|e| (*e).clone());
            if let Some(e) = e {
                lista.push(e);
            }
        }
        lista.truncate(self.cfg.etapa2_ejercicios);
        // Si todos ya se usaron, se libera el nivel para la siguiente vuelta.
        if lista
            .iter()
            .all(|e| self.perfil.ejercicios_usados.contains(&e.id))
        {
            for e in &n.ejercicios {
                self.perfil.ejercicios_usados.remove(&e.id);
            }
        }
        for e in &lista {
            self.perfil.ejercicios_usados.insert(e.id.clone());
        }
        lista
    }

    /// [PROPUESTA] E2-02: una Etapa 2 de `total` ejercicios puede terminar
    /// antes del último, así que no se le promete el total al Alumno.
    fn e2_puede_terminar_antes(&self, total: usize) -> bool {
        let n = self.cfg.etapa2_aciertos_seguidos;
        n > 0 && n < total
    }

    /// [PROPUESTA] E2-02: los últimos ejercicios salieron bien al primer
    /// intento y sin pistas, lo mismo que mide MET-01.
    fn e2_dominada(&self, e2: &E2) -> bool {
        let n = self.cfg.etapa2_aciertos_seguidos;
        n > 0 && e2.primer.len() >= n && e2.primer[e2.primer.len() - n..].iter().all(|x| *x)
    }

    fn iniciar_e2(&mut self, nivel: u8, out: &mut Vec<Mensaje>) {
        self.marcar_ruta(format!("e2-{nivel}"), "Refuerzo", format!("Nivel {nivel}"));
        let lista = self.elegir_e2(nivel);
        let hasta = if self.e2_puede_terminar_antes(lista.len()) {
            "hasta "
        } else {
            ""
        };
        self.aplicar(
            "E2-01",
            &format!(
                "Etapa 2: Refuerzo del nivel {nivel}: {hasta}{} ejercicios autónomos",
                lista.len()
            ),
        );
        out.push(msg(format!(
            "Etapa 2: Refuerzo. Ahora te toca a ti: son {hasta}{} ejercicios. Si te trabas, pídeme una pista.",
            lista.len()
        )));
        let actual = Ex::new(lista[0].clone(), self.ahora());
        self.act = Actividad::Etapa2(Box::new(E2 {
            nivel,
            lista,
            idx: 0,
            actual,
            primer: vec![],
        }));
        self.presentar(out, true);
    }

    fn calificar_e2(&mut self, mut e2: Box<E2>, c: Calificacion, out: &mut Vec<Mensaje>) {
        if c.ilegible {
            out.push(msg(
                "No te entendí la respuesta. ¿Me la repites? Por ejemplo: «tres cuartos».",
            ));
            self.act = Actividad::Etapa2(e2);
            return;
        }
        let ok = c.respuesta_correcta && c.explicacion_correcta.unwrap_or(true);
        if ok {
            // MET-01: bien al primer intento y sin pistas.
            let primero = e2.actual.fallos == 0 && !e2.actual.ayuda_usada;
            let ex = e2.actual.clone();
            self.registrar_ritmo(&ex);
            e2.primer.push(primero);
            out.push(self.felicitar(&c));
            e2.idx += 1;
            self.cupo_descontar();
            if e2.idx >= e2.lista.len() || self.e2_dominada(&e2) {
                return self.completar_e2(*e2, out);
            }
            e2.actual = Ex::new(e2.lista[e2.idx].clone(), self.ahora());
            self.act = Actividad::Etapa2(e2);
            if self.frontera(out) {
                return;
            }
            return self.presentar(out, true);
        }
        e2.actual.fallos += 1;
        self.reaccion_error(&c, out);
        let cfg = self.cfg.clone();
        match dar_pista(&cfg, &mut e2.actual, Disparo::Error, out) {
            ResPista::Dada(t) => {
                self.aplicar(
                    "E2-03",
                    &format!(
                        "Falló el ejercicio {}: {t}; reintenta ese mismo",
                        e2.idx + 1
                    ),
                );
                self.act = Actividad::Etapa2(e2);
            }
            ResPista::Agotada => {
                // E2-04: vuelve a la Etapa 1 del mismo nivel.
                self.aplicar(
                    "E2-04",
                    &format!(
                        "Volvió a fallar tras pistas y paso a paso: Etapa 1 del nivel {} otra vez",
                        e2.nivel
                    ),
                );
                out.push(msg(
                    "Este nivel tiene su truco, así que vamos a repasarlo desde el principio, con calma. Repetir es parte de aprender, y con el repaso te va a salir.",
                ).clase(Clase::Calma));
                if self.aviso_dado {
                    out.push(msg(
                        "Nos va a tomar un poquito más de lo que te dije, pero vale la pena.",
                    ));
                    self.aviso_dado = false;
                }
                self.e1_lista = None;
                let nivel = e2.nivel;
                self.act = Actividad::Siguiente;
                if self.frontera(out) {
                    return;
                }
                self.iniciar_e1(nivel, out);
            }
        }
    }

    fn completar_e2(&mut self, e2: E2, out: &mut Vec<Mensaje>) {
        let tema = self.tema_principal();
        let reg = RegistroNic {
            tema: tema.clone(),
            nivel: e2.nivel,
            contexto: Contexto::Etapa2,
            primer_intento: e2.primer.clone(),
        };
        self.aplicar(
            "MET-01",
            &format!(
                "Next item correctness nivel {}: {}/{} ({:.0}%)",
                e2.nivel,
                reg.aciertos(),
                reg.primer_intento.len(),
                reg.porcentaje()
            ),
        );
        self.metricas.nic.push(reg);
        if let Some(ini) = self.ttm_inicio.remove(&e2.nivel) {
            let min = (self.activo_ms().saturating_sub(ini)) as f64 / 60000.0;
            self.metricas.ttm.push(RegistroTtm {
                tema: tema.clone(),
                nivel: e2.nivel,
                minutos: min,
            });
            self.perfil
                .time_to_master
                .push((tema.clone(), e2.nivel, min));
            self.aplicar(
                "MET-04",
                &format!("Time-to-master nivel {}: {:.1} min", e2.nivel, min),
            );
        }
        let previo = self.nivel_de(&tema).unwrap_or(0);
        if e2.nivel > previo {
            self.perfil.niveles.insert(tema.clone(), e2.nivel);
        }
        self.niveles_hoy.push(e2.nivel);
        if self
            .obj_actual
            .map(|i| self.objetivos[i].tipo == TipoObjetivo::Extracurricular)
            .unwrap_or(false)
        {
            self.extra_niveles.push(e2.nivel);
        }
        // [PROPUESTA] E2-02: o los hizo todos, o los últimos le salieron bien a
        // la primera (`e2_dominada`) y la Etapa 2 terminó antes.
        let hechos = e2.primer.len();
        let antes = hechos < e2.lista.len();
        let seguidos = self.cfg.etapa2_aciertos_seguidos;
        self.aplicar(
            "E2-02",
            &if antes {
                format!(
                    "Completó {hechos} ejercicios del nivel {}: los últimos {seguidos} bien al primer intento y sin pistas",
                    e2.nivel
                )
            } else {
                format!("Completó los {hechos} ejercicios del nivel {}", e2.nivel)
            },
        );
        if self.remediacion.front() == Some(&e2.nivel) {
            self.remediacion.pop_front();
        }
        self.e1_lista = None;
        let subtema = self.banco.subtema(e2.nivel);
        let texto = if antes {
            format!(
                "¡Completaste la Etapa 2! Te salieron {seguidos} seguidos a la primera, así que ya dominas: {subtema}."
            )
        } else {
            format!("¡Completaste la Etapa 2! Ya dominas: {subtema}.")
        };
        out.push(
            msg(texto)
            .clase(Clase::Exito)
            .ia("Celebra en 1 o 2 frases cortas que el Alumno completó la Etapa 2 y ya domina el subtema. Menciona el subtema. No repitas imágenes de tus mensajes anteriores."),
        );
        self.avanzar(out);
    }

    // ─────────── Tarea / Simulación / Corrección ───────────

    fn iniciar_practica(&mut self, modo: ModoPractica, out: &mut Vec<Mensaje>) {
        let Some(oi) = self.obj_actual else {
            return self.cerrar(out);
        };
        let o = self.objetivos[oi].clone();
        let items: Vec<Item> = match modo {
            ModoPractica::Tarea => self.items_tarea(oi),
            ModoPractica::Correccion => {
                let ev = o
                    .evaluacion_id
                    .as_ref()
                    .and_then(|id| self.banco.evaluaciones.iter().find(|e| &e.id == id))
                    .or(self.banco.evaluaciones.first())
                    .cloned();
                let fall = self.preguntas_falladas(oi);
                fall.into_iter()
                    .map(|e| {
                        let nota = ev.as_ref().and_then(|ev| {
                            ev.preguntas
                                .iter()
                                .find(|p| p.ejercicio.id == e.id)
                                .map(|p| {
                                    format!("En la Evaluación respondiste: {}", p.respuesta_alumno)
                                })
                        });
                        Item { ej: e, nota }
                    })
                    .collect()
            }
            ModoPractica::Simulacion => {
                let objetivo = self.nivel_objetivo(oi);
                let niveles: Vec<u8> = match &self.sim_pendiente {
                    Some(v) => v.clone(),
                    None => {
                        let desde = objetivo
                            .saturating_sub(self.cfg.simulacion_niveles_atras)
                            .max(1);
                        (desde..=objetivo).collect()
                    }
                };
                let n = self.cfg.simulacion_por_tema;
                let mut v = vec![];
                for l in niveles {
                    let sim = &self.banco.nivel(l).simulacion;
                    // PRE-10: ejercicios nuevos en cada ronda.
                    for k in 0..n {
                        let e = &sim[(self.sim_ronda * n + k) % sim.len()];
                        v.push(Item {
                            ej: e.clone(),
                            nota: None,
                        });
                    }
                }
                v
            }
        };
        if items.is_empty()
            && modo == ModoPractica::Tarea
            && matches!(self.foto, EstadoFoto::Leida { .. })
        {
            return self.tarea_preparada(oi, out);
        }
        let (clave, nombre, detalle) = match modo {
            ModoPractica::Tarea => ("tarea", "Tarea", format!("{} ejercicios", items.len())),
            ModoPractica::Simulacion => (
                "simulacion",
                "Simulación",
                format!("{} preguntas", items.len()),
            ),
            ModoPractica::Correccion => (
                "correccion",
                "Corrección",
                format!("{} preguntas", items.len()),
            ),
        };
        self.marcar_ruta(format!("{clave}-{}", self.sim_ronda), nombre, detalle);
        if items.is_empty() {
            self.final_hecho = true;
            return self.objetivo_completado(out);
        }
        let texto = match modo {
            ModoPractica::Tarea => {
                self.aplicar(
                    "TAR-01",
                    "Hace la Tarea él solo; Aule ayuda solo si se traba",
                );
                format!(
                    "¡Ya tienes el nivel! Ahora hagamos tu Tarea: son {} ejercicios. Hazlos tú solo; yo reviso cada respuesta y te ayudo si te trabas.",
                    items.len()
                )
            }
            ModoPractica::Simulacion => {
                self.aplicar(
                    "PRE-08",
                    &format!(
                        "Simulación: {} ejercicios por tema, sin pistas",
                        self.cfg.simulacion_por_tema
                    ),
                );
                if self.sim_ronda == 0 {
                    format!(
                        "Ahora hagamos una Simulación de tu Evaluación: son {} preguntas, como en el examen. Aquí no hay pistas. Tranquilo, con calma: es para practicar.",
                        items.len()
                    )
                } else {
                    format!(
                        "Volvamos a simular solo lo que falló, con {} preguntas nuevas. ¡Tú puedes!",
                        items.len()
                    )
                }
            }
            ModoPractica::Correccion => {
                self.aplicar("COR-05", "Resolver otra vez solo las preguntas que falló");
                format!(
                    "Ahora vamos a resolver otra vez las {} preguntas de tu Evaluación que salieron mal. Los errores son normales: así aprendemos. Si te trabas, te doy pistas.",
                    items.len()
                )
            }
        };
        out.push(msg(texto));
        let actual = Ex::new(items[0].ej.clone(), self.ahora());
        self.act = Actividad::Practica(Box::new(Prac {
            modo,
            items,
            idx: 0,
            actual,
            resultados: vec![],
            ciclos: 0,
            marcados: vec![],
        }));
        self.presentar(out, true);
    }

    /// TAR-01: los ejercicios de la Tarea del objetivo `oi`, que son los de la
    /// Tarea del banco. [PROPUESTA] TAR-08: con el nivel de la foto de su Tarea,
    /// solo los de ese nivel o uno menor.
    fn items_tarea(&self, oi: usize) -> Vec<Item> {
        let Some(t) = self.objetivos[oi]
            .tarea_id
            .as_ref()
            .and_then(|id| self.banco.tareas.iter().find(|t| &t.id == id))
            .or(self.banco.tareas.first())
        else {
            return vec![];
        };
        let hasta = match self.foto {
            EstadoFoto::Leida { nivel } if self.obj_actual == Some(oi) => nivel,
            _ => u8::MAX,
        };
        t.ejercicios
            .iter()
            .filter(|e| e.nivel <= hasta)
            .map(|e| Item {
                ej: e.clone(),
                nota: None,
            })
            .collect()
    }

    /// [PROPUESTA] TAR-08: la Tarea del banco no tiene ejercicios hasta el nivel
    /// de la foto: lo que pide su Tarea ya se practicó, y el objetivo se cumple.
    fn tarea_preparada(&mut self, oi: usize, out: &mut Vec<Mensaje>) {
        self.aplicar(
            "TAR-08",
            "La Tarea del banco no tiene ejercicios hasta el nivel de la foto: ya se practicó lo que pide",
        );
        out.push(
            msg("¡Listo! Ya practicaste lo que pide tu tarea, así que ahora la puedes hacer por tu cuenta.")
                .clase(Clase::Exito),
        );
        self.hechos.push(Hecho::TareaPreparada {
            curso: self.banco.curso.clone(),
            fecha: self.objetivos[oi].fecha,
            subtema: self.banco.subtema(self.nivel_objetivo(oi)).to_string(),
        });
        self.final_hecho = true;
        self.objetivo_completado(out);
    }

    fn calificar_practica(&mut self, mut p: Box<Prac>, c: Calificacion, out: &mut Vec<Mensaje>) {
        if c.ilegible {
            out.push(msg(
                "No te entendí la respuesta. ¿Me la repites? Por ejemplo: «tres cuartos».",
            ));
            self.act = Actividad::Practica(p);
            return;
        }
        let ok = c.respuesta_correcta && c.explicacion_correcta.unwrap_or(true);
        if ok || p.modo == ModoPractica::Simulacion {
            let ex = p.actual.clone();
            self.registrar_ritmo(&ex);
        }
        if p.modo == ModoPractica::Simulacion {
            // PRE-08: sin pistas ni corrección en el momento.
            p.resultados.push(ok);
            self.aplicar(
                "PRE-08",
                &format!(
                    "Simulación pregunta {}: {}",
                    p.idx + 1,
                    if ok { "bien" } else { "con error" }
                ),
            );
            out.push(msg("Anotado.").clase(Clase::Calma));
            return self.siguiente_item(p, out);
        }
        if ok {
            self.aplicar(
                "TAR-03",
                &format!("Ejercicio {} revisado: correcto", p.idx + 1),
            );
            p.resultados.push(true);
            out.push(self.felicitar(&c));
            return self.siguiente_item(p, out);
        }
        p.actual.fallos += 1;
        self.reaccion_error(&c, out);
        let cfg = self.cfg.clone();
        match dar_pista(&cfg, &mut p.actual, Disparo::Error, out) {
            ResPista::Dada(t) => {
                self.aplicar(
                    "TAR-04",
                    &format!("Se trabó: {t}; luego reintenta su ejercicio"),
                );
                self.act = Actividad::Practica(p);
            }
            ResPista::Agotada => {
                p.ciclos += 1;
                let nivel = p.actual.ej.nivel;
                if p.ciclos < self.cfg.ciclos_max_tarea {
                    self.aplicar(
                        "TAR-04",
                        &format!("Agotó pistas y paso a paso: repaso (Etapa 1) del nivel {nivel} y vuelve a su ejercicio"),
                    );
                    out.push(msg(
                        "Vamos a repasar este tema un momento, con calma, y después volvemos a tu ejercicio. ¡Lo vas a lograr!",
                    ).clase(Clase::Calma));
                    p.actual = Ex::new(p.actual.ej.clone(), self.ahora());
                    self.pila.push(Actividad::Practica(p));
                    self.iniciar_e1(nivel, out);
                } else {
                    self.aplicar(
                        "TAR-04",
                        "Sigue trabado tras el repaso: se marca para revisar con el Docente",
                    );
                    out.push(msg(
                        "Este lo dejamos marcado para revisarlo juntos y con tu Docente. No pasa nada: hoy avanzaste muchísimo.",
                    ).clase(Clase::Calma));
                    p.marcados.push(p.idx);
                    p.resultados.push(false);
                    self.siguiente_item(p, out);
                }
            }
        }
    }

    fn siguiente_item(&mut self, mut p: Box<Prac>, out: &mut Vec<Mensaje>) {
        p.idx += 1;
        p.ciclos = 0;
        self.cupo_descontar();
        if p.idx >= p.items.len() {
            return self.completar_practica(*p, out);
        }
        p.actual = Ex::new(p.items[p.idx].ej.clone(), self.ahora());
        self.act = Actividad::Practica(p);
        if self.frontera(out) {
            return;
        }
        self.presentar(out, true);
    }

    fn completar_practica(&mut self, p: Prac, out: &mut Vec<Mensaje>) {
        let Some(oi) = self.obj_actual else {
            return self.cerrar(out);
        };
        let o = self.objetivos[oi].clone();
        let curso = self.banco.curso.clone();
        let tema = self.tema_principal();
        match p.modo {
            ModoPractica::Simulacion => {
                let mut por_nivel: BTreeMap<u8, Vec<bool>> = BTreeMap::new();
                for (it, ok) in p.items.iter().zip(p.resultados.iter()) {
                    por_nivel.entry(it.ej.nivel).or_default().push(*ok);
                }
                for (l, v) in &por_nivel {
                    self.metricas.nic.push(RegistroNic {
                        tema: tema.clone(),
                        nivel: *l,
                        contexto: Contexto::Simulacion,
                        primer_intento: v.clone(),
                    });
                }
                let fallados: Vec<u8> = por_nivel
                    .iter()
                    .filter(|(_, v)| v.iter().any(|x| !x))
                    .map(|(l, _)| *l)
                    .collect();
                let bien: Vec<u8> = por_nivel
                    .iter()
                    .filter(|(_, v)| v.iter().all(|x| *x))
                    .map(|(l, _)| *l)
                    .collect();
                if fallados.is_empty() {
                    self.aplicar("PRE-10", "Simulación sin errores");
                    out.push(msg("¡Terminamos la Simulación y te fue muy bien! Estás listo para tu Evaluación.").clase(Clase::Exito));
                    self.final_hecho = true;
                    let subtemas = self.subtemas_objetivo(oi);
                    self.hechos.push(Hecho::Preparacion {
                        curso,
                        temas: vec![tema],
                        fecha: o.fecha,
                        subtemas,
                    });
                    return self.objetivo_completado(out);
                }
                // PRE-09: comparar su nivel con el de la pregunta que falló → Etapa 1 y 2.
                let banco = self.banco.clone();
                let sub = |v: &[u8]| -> Vec<String> {
                    v.iter().map(|l| banco.subtema(*l).to_string()).collect()
                };
                if !self.sim_errores_informados {
                    self.hechos.push(Hecho::SimulacionConErrores {
                        curso,
                        fecha: o.fecha,
                        bien: sub(&bien),
                        mal: sub(&fallados),
                    });
                    self.sim_errores_informados = true;
                }
                let nivel = self.nivel_de(&tema).unwrap_or(0);
                self.aplicar(
                    "PRE-09",
                    &format!(
                        "Falló en niveles {:?} (su nivel es {nivel}): Etapa 1 y 2 de esos niveles",
                        fallados
                    ),
                );
                out.push(msg(format!(
                    "¡Terminamos la Simulación! Te fue bien en varias, y tuviste errores en {}. Es normal, y qué bueno que lo vimos ahora y no en la Evaluación. Vamos a reforzarlo.",
                    lista(&sub(&fallados))
                )).clase(Clase::Calma));
                self.remediacion = fallados.iter().copied().collect();
                self.sim_pendiente = Some(fallados);
                self.sim_ronda += 1;
                self.e1_lista = None;
                self.avanzar(out)
            }
            ModoPractica::Tarea | ModoPractica::Correccion => {
                self.final_hecho = true;
                if !p.marcados.is_empty() {
                    let faltan: Vec<String> = p
                        .marcados
                        .iter()
                        .map(|k| format!("el ejercicio {}", k + 1))
                        .collect();
                    self.objetivos[oi].estado = EstadoObjetivo::Pendiente;
                    self.hechos.push(Hecho::ObjetivoContinua {
                        curso,
                        temas: vec![tema],
                        es_tarea: p.modo == ModoPractica::Tarea,
                        fecha: o.fecha,
                        dominados: self.subtemas_hoy(),
                        faltan,
                        proxima: self.perfil.proxima_sesion,
                    });
                    out.push(msg(
                        "¡Terminamos! Dejamos marcado lo que revisaremos la próxima vez.",
                    ));
                    self.obj_actual = None;
                    return self.despues_de_objetivo(out);
                }
                if p.modo == ModoPractica::Tarea {
                    out.push(
                        msg("¡Terminaste tu Tarea! Todo revisado y bien hecho.")
                            .clase(Clase::Exito),
                    );
                    let subtemas = self.subtemas_objetivo(oi);
                    self.hechos.push(Hecho::Tarea {
                        curso,
                        temas: vec![tema],
                        fecha: o.fecha,
                        subtemas,
                    });
                } else {
                    out.push(msg("¡Listo! Ahora resuelves por tu cuenta las preguntas que antes fallaste.").clase(Clase::Exito));
                    let temas: Vec<String> = p
                        .items
                        .iter()
                        .map(|i| i.ej.nivel)
                        .collect::<BTreeSet<_>>()
                        .into_iter()
                        .map(|l| self.banco.subtema(l).to_string())
                        .collect();
                    self.hechos.push(Hecho::Correccion {
                        curso,
                        fecha: o.fecha,
                        temas,
                    });
                }
                self.objetivo_completado(out)
            }
        }
    }

    fn subtemas_hoy(&self) -> Vec<String> {
        let mut v: Vec<u8> = self.niveles_hoy.clone();
        v.sort();
        v.dedup();
        v.iter()
            .map(|l| self.banco.subtema(*l).to_string())
            .collect()
    }

    /// Subtemas que domina para el objetivo (los aprendidos hoy, o el del nivel objetivo).
    fn subtemas_objetivo(&self, oi: usize) -> Vec<String> {
        let hoy = self.subtemas_hoy();
        if !hoy.is_empty() {
            return hoy;
        }
        vec![self.banco.subtema(self.nivel_objetivo(oi)).to_string()]
    }

    fn objetivo_completado(&mut self, out: &mut Vec<Mensaje>) {
        if let Some(i) = self.obj_actual.take() {
            self.objetivos[i].estado = EstadoObjetivo::Completado;
            let t = self.objetivos[i].tipo;
            self.aplicar("OBJ-05", &format!("Objetivo completado: {}", t.nombre()));
        }
        self.despues_de_objetivo(out);
    }

    fn despues_de_objetivo(&mut self, out: &mut Vec<Mensaje>) {
        let min = self.transcurrido_min();
        if self.aviso_dado || min >= self.cfg.umbral_extracurricular_min as f64 {
            self.aplicar("SES-02", "Objetivo terminado después de 30 minutos: cierre");
            return self.cerrar(out);
        }
        if self
            .objetivos
            .iter()
            .any(|o| o.estado == EstadoObjetivo::Pendiente)
        {
            self.aplicar(
                "SES-02",
                "Objetivo terminado antes de 30 minutos: sigue el siguiente pendiente",
            );
            out.push(msg("¡Todavía tenemos tiempo! Sigamos con lo siguiente."));
        }
        self.avanzar(out);
    }

    // ─────────── pistas ───────────

    fn ayuda(&mut self, out: &mut Vec<Mensaje>) {
        match self.act.clone() {
            Actividad::Tamizaje(_) => {
                // A10 / PIS-04: sin pistas en el Tamizaje.
                self.aplicar("PIS-04", "No hay pistas en el Tamizaje");
                out.push(msg(
                    "En el Tamizaje no te puedo dar pistas, porque quiero ver cómo lo piensas tú. Hazlo con calma; si no sabes, cuéntame hasta dónde llegaste. ¡No pasa nada si fallamos!",
                ).clase(Clase::Calma));
            }
            Actividad::Practica(p) if p.modo == ModoPractica::Simulacion => {
                self.aplicar("PIS-04", "No hay pistas en la Simulación");
                out.push(msg(
                    "En la Simulación no hay pistas, como en la Evaluación. Haz tu mejor intento; después repasamos juntos lo que haga falta.",
                ).clase(Clase::Calma));
            }
            Actividad::Etapa2(mut e2) => {
                e2.actual.ayuda_usada = true;
                let cfg = self.cfg.clone();
                if let ResPista::Dada(t) = dar_pista(&cfg, &mut e2.actual, Disparo::Ayuda, out) {
                    self.aplicar("PIS-01", &format!("Pidió ayuda: {t}"));
                }
                self.act = Actividad::Etapa2(e2);
            }
            Actividad::Practica(mut p) => {
                p.actual.ayuda_usada = true;
                let cfg = self.cfg.clone();
                if let ResPista::Dada(t) = dar_pista(&cfg, &mut p.actual, Disparo::Ayuda, out) {
                    self.aplicar("PIS-01", &format!("Pidió ayuda: {t}"));
                }
                self.act = Actividad::Practica(p);
            }
            Actividad::Etapa1(e1) => self.calificar_e1(e1, Calificacion::default(), true, out),
            _ => out.push(msg("Aquí estoy. ¿En qué te ayudo?")),
        }
    }

    fn felicitar(&mut self, c: &Calificacion) -> Mensaje {
        let e = self.rota(&EXITO).to_string();
        // Variedad: solo una de cada tres felicitaciones lleva un guiño a sus intereses.
        let guino = if self.contador.is_multiple_of(3) {
            "Puedes hacer un guiño breve a sus intereses, sin repetir imágenes de tus mensajes anteriores."
        } else {
            "Esta vez sin metáforas ni referencias a sus intereses: di algo concreto sobre lo que hizo."
        };
        match &c.comentario {
            Some(com) if !com.trim().is_empty() => msg(com.clone()).clase(Clase::Exito),
            _ => msg(e).clase(Clase::Exito).ia(format!(
                "El Alumno respondió {} y su respuesta YA FUE VERIFICADA COMO CORRECTA: no la vuelvas a calcular, no digas que está mal ni pidas revisarla. Felicítalo en UNA frase corta y concreta (máx. 12 palabras). {guino}",
                c.respuesta_leida.clone().unwrap_or_else(|| "bien".into())
            )),
        }
    }

    fn reaccion_error(&mut self, c: &Calificacion, out: &mut Vec<Mensaje>) {
        // PIS-05 / COR-02: el error no se sataniza ni se vuelve identidad.
        let t = if c.forma_incorrecta {
            "Tu resultado vale lo mismo, ¡bien! Pero fíjate en la forma que pide el ejercicio."
                .to_string()
        } else if c.respuesta_correcta && c.explicacion_correcta == Some(false) {
            match &c.comentario {
                Some(com) if !com.trim().is_empty() => com.clone(),
                _ => "Tu respuesta está bien, pero falta justificar mejor por qué.".to_string(),
            }
        } else {
            match &c.comentario {
                Some(com) if !com.trim().is_empty() => com.clone(),
                // Variadas, como los elogios: oír la misma frase en cada error cansa.
                _ => self
                    .rota(&[
                        "Todavía no. Equivocarse es parte de aprender, vamos a pensarlo juntos.",
                        "Esa no es. Tranquilo, lo vemos juntos.",
                        "Casi. Vamos a revisarlo con calma.",
                        "Todavía no sale, y está bien. Lo pensamos de nuevo.",
                    ])
                    .to_string(),
            }
        };
        out.push(msg(t).clase(Clase::Calma));
    }

    // ─────────── calificación ───────────

    fn calificada(&mut self, c: Calificacion, out: &mut Vec<Mensaje>) {
        match self.act.clone() {
            Actividad::Tamizaje(t) => self.calificar_tamizaje(t, c, out),
            Actividad::Etapa1(e1) => self.calificar_e1(e1, c, false, out),
            Actividad::Etapa2(e2) => self.calificar_e2(e2, c, out),
            Actividad::Practica(p) => self.calificar_practica(p, c, out),
            _ => {}
        }
    }

    // ─────────── pausas ───────────

    fn cansado(&mut self, out: &mut Vec<Mensaje>) {
        match self.act {
            Actividad::Pausa(_) | Actividad::Terminada | Actividad::NoIniciada => {
                out.push(msg("Te entiendo. Descansa un poquito."));
            }
            _ if self.es_de_noche() => {
                // [PROPUESTA] PAU-07: de noche no se propone moverse. Quien está
                // cansado descansa y la sesión se cierra, con su despedida.
                self.aplicar("PAU-07", "Dijo que está cansado y ya es de noche: cierre");
                out.push(msg("Ya es tarde, y lo mejor ahora es descansar: mientras duermes, tu cerebro también aprende lo que practicamos. Por hoy lo dejamos aquí y seguimos en la próxima sesión.").clase(Clase::Calma));
                self.cerrar(out);
            }
            _ => {
                self.aplicar("PAU-05", "Dijo que está cansado: Pausa activa ahora");
                out.push(msg("Gracias por decirme. Hagamos una Pausa activa y luego seguimos donde nos quedamos.").clase(Clase::Calma));
                self.entrar_pausa(true, out);
            }
        }
    }

    /// [PROPUESTA] PAU-07: si ahora es de noche donde vive la familia.
    fn es_de_noche(&self) -> bool {
        let Some(inicio) = self.perfil.minuto_inicio else {
            return false;
        };
        let ahora = (u64::from(inicio) + self.ahora() / 60_000) % 1440;
        ahora >= u64::from(self.cfg.noche_desde_min) || ahora < u64::from(self.cfg.noche_hasta_min)
    }

    fn entrar_pausa(&mut self, por_cansancio: bool, out: &mut Vec<Mensaje>) {
        let previa = std::mem::replace(&mut self.act, Actividad::Siguiente);
        self.pausas_tomadas += 1;
        let acts = self.cfg.actividades_pausa.clone();
        // [PROPUESTA] La línea nombra las actividades: por voz la tabla no se
        // ve, y quien todavía no lee no tiene otra forma de saber cuáles hay.
        let nombres: Vec<String> = acts.iter().map(|a| a.nombre.clone()).collect();
        let elige = if nombres.is_empty() {
            String::new()
        } else {
            format!(" Elige una: {}.", lista_o(&nombres))
        };
        out.push(
            msg(format!(
                "¡Pausa activa! Son {} minutos para mover el cuerpo o respirar. ¿Cómo te sientes?{elige}",
                self.cfg.pausa_duracion_s / 60
            ))
            .adj(Adjunto::Actividades { actividades: acts }),
        );
        self.act = Actividad::Pausa(Box::new(Pausa {
            previa: Box::new(previa),
            inicio_ms: self.ahora(),
            eleccion: None,
            por_cansancio,
        }));
    }

    /// [PROPUESTA] La actividad que se le propone a quien no eligió una: la
    /// siguiente de la lista y, a quien dijo que está cansado, la siguiente de
    /// las relajantes. A un Alumno cansado no se le venden unos saltos de
    /// estrella (sesión de prueba del 2026-11-25).
    fn actividad_propuesta(&self, por_cansancio: bool) -> usize {
        let acts = &self.cfg.actividades_pausa;
        let vuelta = (self.pausas_tomadas as usize).saturating_sub(1);
        if por_cansancio {
            let relajantes: Vec<usize> = acts
                .iter()
                .enumerate()
                .filter(|(_, a)| a.tipo == TipoPausa::Relajante)
                .map(|(k, _)| k)
                .collect();
            if !relajantes.is_empty() {
                return relajantes[vuelta % relajantes.len()];
            }
        }
        vuelta % acts.len().max(1)
    }

    fn leer_actividad(&self, t: &str) -> Option<usize> {
        let n = normalizar(t);
        let acts = &self.cfg.actividades_pausa;
        if let Some(k) = acts.iter().position(|a| n.contains(&normalizar(&a.nombre))) {
            return Some(k);
        }
        // Si no, por una de las palabras que cada actividad trae consigo.
        acts.iter().position(|a| {
            a.palabras
                .iter()
                .map(|p| normalizar(p))
                .any(|p| !p.is_empty() && n.contains(&p))
        })
    }

    fn elegir_actividad(&mut self, k: usize, out: &mut Vec<Mensaje>) {
        let Actividad::Pausa(mut p) = self.act.clone() else {
            return;
        };
        let Some(a) = self.cfg.actividades_pausa.get(k).cloned() else {
            return;
        };
        p.eleccion = Some(k);
        self.aplicar("PAU-06", &format!("Eligió la actividad: {}", a.nombre));
        let pasos = a
            .pasos
            .iter()
            .enumerate()
            .map(|(i, s)| format!("{}. {s}", i + 1))
            .collect::<Vec<_>>()
            .join(" ");
        out.push(msg(format!("¡{}! {pasos}", a.nombre)));
        self.act = Actividad::Pausa(p);
    }

    fn pausa_restante_s(&self, p: &Pausa) -> u64 {
        let pasado = self.ahora().saturating_sub(p.inicio_ms) / 1000;
        self.cfg.pausa_duracion_s.saturating_sub(pasado)
    }

    fn terminar_pausa(&mut self, out: &mut Vec<Mensaje>) {
        let Actividad::Pausa(p) = std::mem::replace(&mut self.act, Actividad::Siguiente) else {
            return;
        };
        self.pausa_total_ms += self.ahora().saturating_sub(p.inicio_ms);
        out.push(msg("¡Listo, seguimos!"));
        match *p.previa {
            Actividad::Siguiente => self.avanzar(out),
            otra => {
                self.act = otra;
                self.reiniciar_tiempo_ejercicio();
                self.presentar(out, false);
            }
        }
    }

    fn reiniciar_tiempo_ejercicio(&mut self) {
        let ahora = self.ahora();
        match &mut self.act {
            Actividad::Etapa2(e) => e.actual.inicio_ms = ahora,
            Actividad::Practica(p) => p.actual.inicio_ms = ahora,
            _ => {}
        }
    }

    /// Frontera entre ejercicios: aquí entran pausas y cierres (PAU-04: nunca en medio).
    fn frontera(&mut self, out: &mut Vec<Mensaje>) -> bool {
        if !self.iniciada || matches!(self.act, Actividad::Terminada) {
            return false;
        }
        let min = self.transcurrido_min();
        if self.cupo == Some(0) {
            self.aplicar(
                "SES-06",
                "Se completaron los últimos ejercicios avisados: cierre",
            );
            self.cerrar(out);
            return true;
        }
        if min >= self.cfg.sesion_maxima_min as f64 {
            self.aplicar("SES-01", "Se alcanzó el tiempo máximo de la sesión: cierre");
            if !self.aviso_dado {
                out.push(msg(format!("{}, ya llegamos al final de la sesión de hoy, así que aquí paramos y lo retomamos la próxima vez.", self.nombre())).clase(Clase::Aviso));
            }
            self.cerrar(out);
            return true;
        }
        let k = self.pausas_tomadas as usize;
        if let Some(&m) = self.cfg.pausas_en_min.get(k) {
            if min >= m as f64 && m < self.cfg.sesion_maxima_min {
                let id = if k == 0 { "PAU-02" } else { "PAU-03" };
                self.aplicar(
                    id,
                    &format!("Minuto {m}: Pausa activa al terminar el ejercicio en curso (PAU-04)"),
                );
                self.entrar_pausa(false, out);
                return true;
            }
        }
        false
    }

    /// Frontera dentro de la Etapa 1 (entre explicación y ejemplos).
    fn frontera_suave(&mut self, out: &mut Vec<Mensaje>) -> bool {
        if self.cupo.is_some() {
            // SES-06: si ya avisamos el cierre, no empezamos una explicación nueva.
            return false;
        }
        self.frontera(out)
    }

    fn tick(&mut self, out: &mut Vec<Mensaje>) {
        if !self.iniciada {
            return;
        }
        match self.act.clone() {
            Actividad::Pausa(p) => {
                if self.pausa_restante_s(&p) == 0 {
                    self.aplicar("PAU-06", "Pasaron los 5 minutos de la pausa");
                    self.terminar_pausa(out);
                }
            }
            Actividad::Etapa2(mut e2) => {
                if self.disparo_tiempo(&mut e2.actual, out) {
                    self.act = Actividad::Etapa2(e2);
                }
                self.revisar_aviso(out);
            }
            Actividad::Practica(mut p) => {
                if p.modo != ModoPractica::Simulacion && self.disparo_tiempo(&mut p.actual, out) {
                    self.act = Actividad::Practica(p);
                }
                self.revisar_aviso(out);
            }
            _ => {}
        }
    }

    /// PIS-01: se pasó del tiempo promedio del ejercicio.
    fn disparo_tiempo(&mut self, ex: &mut Ex, out: &mut Vec<Mensaje>) -> bool {
        if !self.cfg.pista_por_tiempo || ex.pista_tiempo || ex.ej.tiempo_s == 0 {
            return false;
        }
        let pasado_s = self.ahora().saturating_sub(ex.inicio_ms) as f64 / 1000.0;
        if pasado_s < ex.ej.tiempo_s as f64 * self.cfg.pista_tiempo_factor {
            return false;
        }
        ex.pista_tiempo = true;
        ex.ayuda_usada = true;
        let cfg = self.cfg.clone();
        if let ResPista::Dada(t) = dar_pista(&cfg, ex, Disparo::Tiempo, out) {
            self.aplicar(
                "PIS-01",
                &format!("Pasó el tiempo promedio ({} s): {t}", ex.ej.tiempo_s),
            );
        }
        true
    }

    // ─────────── avisos de cierre (SES-04..07) ───────────

    fn cupo_descontar(&mut self) {
        if let Some(c) = self.cupo.as_mut() {
            *c = c.saturating_sub(1);
        }
    }

    /// Unidades que faltan para completar el objetivo actual, en orden.
    fn unidades_restantes(&self) -> Vec<Unidad> {
        let f = self.cfg.factor_tiempo * self.factor_ritmo();
        let mut v = vec![];
        let tema = self.tema_principal();
        let prom = |l: u8| -> f64 {
            let n = self.banco.nivel(l);
            n.ejercicios.iter().map(|e| e.tiempo_s as f64).sum::<f64>()
                / n.ejercicios.len().max(1) as f64
                * f
        };
        let e1_s = self.cfg.etapa1_min_estimados as f64 * 60.0 * f;
        let mut actividades: Vec<&Actividad> = vec![&self.act];
        if let Actividad::Pausa(p) = &self.act {
            actividades = vec![&p.previa];
        }
        actividades.extend(self.pila.iter().rev());
        let mut nivel_tras = self.nivel_de(&tema).unwrap_or(0);
        let mut e1_hecha = self.e1_lista;
        let mut practica_en_curso = false;
        for a in actividades {
            match a {
                Actividad::Tamizaje(t) => {
                    let por = self.cfg.tamizaje_min_estimados as f64 * 60.0 / 5.0 * f;
                    for _ in t.nivel..=self.cfg.niveles_por_tema {
                        v.push(Unidad::Ejercicio(por));
                    }
                    nivel_tras = Self::ultimo_consecutivo(&t.respuestas);
                }
                Actividad::Etapa1(e) => {
                    v.push(Unidad::Otro(e1_s * 0.6));
                    for _ in 0..self.cfg.etapa2_ejercicios {
                        v.push(Unidad::Ejercicio(prom(e.nivel)));
                    }
                    nivel_tras = nivel_tras.max(e.nivel);
                    e1_hecha = None;
                }
                Actividad::Etapa2(e) => {
                    for x in &e.lista[e.idx..] {
                        v.push(Unidad::Ejercicio(x.tiempo_s as f64 * f));
                    }
                    nivel_tras = nivel_tras.max(e.nivel);
                    e1_hecha = None;
                }
                Actividad::Practica(p) => {
                    for x in &p.items[p.idx..] {
                        v.push(Unidad::Ejercicio(x.ej.tiempo_s as f64 * f));
                    }
                    practica_en_curso = true;
                }
                _ => {}
            }
        }
        let Some(oi) = self.obj_actual else {
            return v;
        };
        if practica_en_curso && self.pila.is_empty() {
            return v;
        }
        let o = &self.objetivos[oi];
        let objetivo = self.nivel_objetivo(oi);
        for &l in &self.remediacion {
            if e1_hecha != Some(l) {
                v.push(Unidad::Otro(e1_s));
            }
            for _ in 0..self.cfg.etapa2_ejercicios {
                v.push(Unidad::Ejercicio(prom(l)));
            }
            e1_hecha = None;
        }
        if nivel_tras < objetivo {
            for l in (nivel_tras + 1)..=objetivo {
                if e1_hecha != Some(l) {
                    v.push(Unidad::Otro(e1_s));
                }
                e1_hecha = None;
                for _ in 0..self.cfg.etapa2_ejercicios {
                    v.push(Unidad::Ejercicio(prom(l)));
                }
            }
        }
        if !self.final_hecho && !practica_en_curso {
            match o.tipo {
                TipoObjetivo::Tarea => {
                    for it in self.items_tarea(oi) {
                        v.push(Unidad::Ejercicio(it.ej.tiempo_s as f64 * f));
                    }
                }
                TipoObjetivo::Preparacion => {
                    let n = match &self.sim_pendiente {
                        Some(x) => x.len(),
                        None => {
                            (objetivo
                                - objetivo
                                    .saturating_sub(self.cfg.simulacion_niveles_atras)
                                    .max(1)
                                + 1) as usize
                        }
                    } * self.cfg.simulacion_por_tema;
                    for _ in 0..n {
                        v.push(Unidad::Ejercicio(prom(objetivo)));
                    }
                }
                TipoObjetivo::Correccion => {
                    for e in self.preguntas_falladas(oi) {
                        v.push(Unidad::Ejercicio(e.tiempo_s as f64 * f));
                    }
                }
                TipoObjetivo::Extracurricular => {}
            }
        }
        v
    }

    /// Los tiempos son referenciales (SES-06): se ajustan al ritmo real del Alumno.
    fn factor_ritmo(&self) -> f64 {
        if self.ritmo.is_empty() {
            return 1.0;
        }
        let r = self.ritmo.iter().rev().take(8).sum::<f64>() / self.ritmo.len().min(8) as f64;
        r.clamp(1.0, 3.0)
    }

    fn registrar_ritmo(&mut self, ex: &Ex) {
        if ex.ej.tiempo_s > 0 {
            let real = self.ahora().saturating_sub(ex.inicio_ms) as f64 / 1000.0;
            self.ritmo.push(real / ex.ej.tiempo_s as f64);
        }
    }

    /// Duración proyectada de la sesión en minutos (SES-05 [PROPUESTA]).
    pub fn proyeccion_min(&self) -> f64 {
        let resto: f64 = self
            .unidades_restantes()
            .iter()
            .map(|u| match u {
                Unidad::Ejercicio(s) | Unidad::Otro(s) => *s,
            })
            .sum();
        self.transcurrido_min() + resto / 60.0
    }

    /// Se llama al presentar un ejercicio nuevo: decide si toca avisar el cierre.
    fn revisar_aviso(&mut self, out: &mut Vec<Mensaje>) {
        if self.aviso_dado {
            return;
        }
        if self.obj_actual.is_none() {
            return;
        }
        let u = self.unidades_restantes();
        let ahora = self.transcurrido_min();
        let total = if self.cfg.usar_duracion_proyectada {
            self.proyeccion_min()
        } else {
            ahora
        };
        let max = self.cfg.sesion_maxima_min as f64;
        if total > max {
            // SES-06: no se completa; avisar faltando 3 ejercicios para cumplir 1h30.
            let mut acc = ahora * 60.0;
            let mut caben = 0u32;
            for x in &u {
                match x {
                    Unidad::Ejercicio(s) => {
                        if acc + s > max * 60.0 {
                            break;
                        }
                        acc += s;
                        caben += 1;
                    }
                    Unidad::Otro(s) => {
                        if acc + s > max * 60.0 {
                            break;
                        }
                        acc += s;
                    }
                }
            }
            let n = self.cfg.aviso_no_completa;
            if caben <= n {
                let n_aviso = caben.max(1);
                self.aplicar(
                    "SES-06",
                    &format!("El objetivo no se completa hoy (proyección {total:.0} min): aviso faltando {n_aviso}"),
                );
                self.dar_aviso(n_aviso, out);
                self.cupo = Some(n_aviso);
            }
            return;
        }
        if u.iter().any(|x| matches!(x, Unidad::Otro(_))) {
            return;
        }
        let ej = u
            .iter()
            .filter(|x| matches!(x, Unidad::Ejercicio(_)))
            .count() as u32;
        let n = if total <= self.cfg.sesion_minima_min as f64 {
            0
        } else if total <= self.cfg.sesion_recomendada_min as f64 {
            self.cfg.aviso_hasta_recomendada
        } else {
            self.cfg.aviso_hasta_maxima
        };
        if n > 0 && ej > 0 && ej <= n {
            self.aplicar(
                "SES-05",
                &format!("Proyección {total:.0} min: aviso faltando {n} ejercicios"),
            );
            self.dar_aviso(ej, out);
        }
    }

    fn dar_aviso(&mut self, n: u32, out: &mut Vec<Mensaje>) {
        self.aviso_dado = true;
        let cuantos = if n == 1 {
            "este es nuestro último ejercicio por hoy".to_string()
        } else {
            format!("estos son nuestros últimos {n} ejercicios por hoy")
        };
        // SES-07
        out.push(
            msg(format!(
                "{}, por cierto, {cuantos}. Si quieres otra sesión, dime cuándo y se lo cuento a tu familia.",
                self.nombre()
            ))
            .clase(Clase::Aviso),
        );
    }

    // ─────────── cierre ───────────

    fn cerrar(&mut self, out: &mut Vec<Mensaje>) {
        if matches!(self.act, Actividad::Terminada) {
            return;
        }
        let actual = std::mem::replace(&mut self.act, Actividad::Terminada);
        let actual = match actual {
            Actividad::Pausa(p) => *p.previa,
            a => a,
        };
        if let Actividad::Tamizaje(t) = &actual {
            // Tamizaje incompleto por cierre: se guarda para retomar (TAM-06).
            let retomar = t.nivel;
            self.perfil.tamizaje_parcial.insert(
                t.tema.clone(),
                TamizajeParcial {
                    respuestas: t.respuestas.clone(),
                    retomar_en: retomar,
                    usadas: t.usadas.clone(),
                },
            );
            self.perfil
                .niveles
                .insert(t.tema.clone(), Self::ultimo_consecutivo(&t.respuestas));
            self.hechos.push(Hecho::TamizajeIncompleto {
                curso: self.banco.curso.clone(),
                tema: t.tema.clone(),
                proxima: self.perfil.proxima_sesion,
            });
        }
        // TAM-08: un plan que esperaba la foto de la Tarea va igual al Informe.
        self.registrar_plan();
        // Objetivo que continúa.
        if let Some(i) = self.obj_actual.take() {
            let o = self.objetivos[i].clone();
            if o.tipo == TipoObjetivo::Extracurricular {
                self.objetivos[i].estado = EstadoObjetivo::Completado;
                self.push_hecho_extra();
            } else if o.estado == EstadoObjetivo::EnCurso {
                self.objetivos[i].estado = EstadoObjetivo::Pendiente;
                let tema = self.tema_principal();
                let nivel = self.nivel_de(&tema).unwrap_or(0);
                let objetivo = self.nivel_objetivo(i);
                let mut faltan: Vec<String> = ((nivel + 1)..=objetivo)
                    .map(|l| self.banco.subtema(l).to_string())
                    .collect();
                if faltan.is_empty() {
                    faltan.push(match o.tipo {
                        TipoObjetivo::Tarea => "terminar la tarea".into(),
                        TipoObjetivo::Preparacion => "terminar la simulación".into(),
                        _ => "resolver las preguntas que falló".into(),
                    });
                }
                if !matches!(actual, Actividad::Tamizaje(_)) || !self.niveles_hoy.is_empty() {
                    self.hechos.push(Hecho::ObjetivoContinua {
                        curso: o.curso.clone(),
                        temas: vec![o.tema.clone()],
                        es_tarea: o.tipo == TipoObjetivo::Tarea,
                        fecha: o.fecha,
                        dominados: self.subtemas_hoy(),
                        faltan,
                        proxima: self.perfil.proxima_sesion,
                    });
                }
                self.aplicar(
                    "DEMO-15",
                    "El objetivo queda pendiente para la próxima sesión",
                );
            }
        }
        self.aplicar("SES-04", "Cierre con despedida (nunca abrupto)");
        out.push(
            msg(format!(
                "¡Gran trabajo hoy, {}! Me encantó trabajar contigo. ¡Nos vemos pronto!",
                self.nombre(),
            ))
            .ia(format!(
                "Despedida de la sesión, cálida y breve (2 o 3 frases): reconoce el esfuerzo del Alumno y lo que logró hoy ({}). No digas una fecha.",
                if self.subtemas_hoy().is_empty() { "trabajó con constancia".to_string() } else { lista(&self.subtemas_hoy()) },
            )),
        );
    }

    pub fn informe(&self) -> Vec<String> {
        let mut hechos = self.hechos.clone();
        // TAM-08: una sesión que se cortó mientras se esperaba la foto de la
        // Tarea también cuenta el Tamizaje, con el plan hasta el Nivel objetivo
        // que hay ahora: sin la foto, el de la Tarea del banco.
        if let Some((tema, nivel)) = &self.plan_pendiente {
            hechos.push(self.resultado_tamizaje(tema.clone(), *nivel).0);
        }
        let mut m = informe::generar(
            &self.perfil.nombre_padre,
            &self.perfil.nombre_alumno,
            &hechos,
        );
        if let Some(s) = &self.sesion_adicional {
            m.push(format!(
                "{} nos comentó que le gustaría una sesión adicional el {s}. ¿Te parece bien?",
                self.perfil.nombre_alumno
            ));
        }
        m
    }

    pub fn terminada(&self) -> bool {
        matches!(self.act, Actividad::Terminada)
    }

    // ─────────── presentar el paso actual ───────────

    fn presentar(&mut self, out: &mut Vec<Mensaje>, nuevo: bool) {
        match self.act.clone() {
            Actividad::Tamizaje(t) => {
                if !nuevo {
                    out.push(msg("Seguimos con el Tamizaje."));
                }
                out.push(msg(format!(
                    "Pregunta {} de {}.",
                    t.nivel, self.cfg.niveles_por_tema
                )));
            }
            Actividad::Etapa1(e1) => {
                let c = self.nivel_c(e1.nivel);
                match e1.fase {
                    FaseE1::Teoria(i) => {
                        let b = &c.etapa1.teoria[i];
                        let mut m = msg(b.texto.clone()).clase(Clase::Teoria);
                        if self.e1_vueltas.get(&e1.nivel).copied().unwrap_or(1) > 1 {
                            // Al repetir el nivel (E2-04) la misma idea se cuenta de otra forma.
                            m = m.ia(format!(
                                "Estás repitiendo la teoría de este nivel porque al Alumno le costó. Cuenta ESTA misma idea con otras palabras, más simple, en máximo 3 frases, con un ejemplo de sus intereses. No cambies los números ni agregues ideas nuevas. Texto original: \"{}\"",
                                b.texto
                            ));
                        }
                        if let Some(g) = &b.grafico {
                            m = m.adj(Adjunto::Grafico { grafico: g.clone() });
                        }
                        if i == 0 {
                            self.aplicar("E1-02", "Teoría que parte del nivel que ya alcanzó");
                        }
                        out.push(m);
                        self.preguntar_si_seguimos(out);
                    }
                    FaseE1::NoAsistido(i) => {
                        let ej = &c.etapa1.no_asistidos[i];
                        if i == 0 {
                            self.aplicar(
                                "E1-03",
                                "Ejemplos no asistidos: Aule hace todos los pasos",
                            );
                        }
                        let intro = if i == 0 {
                            "Mira cómo lo resuelvo yo, paso a paso:"
                        } else {
                            "Otro ejemplo, mira:"
                        };
                        out.push(msg(intro).adj(Adjunto::Pasos {
                            titulo: "Ejemplo resuelto".into(),
                            enunciado: ej.enunciado.clone(),
                            pasos: ej.pasos.clone(),
                            grafico: ej.grafico.clone(),
                        }));
                        self.preguntar_si_seguimos(out);
                    }
                    FaseE1::Asistido { ej, paso, .. } => {
                        let x = &c.etapa1.asistidos[ej];
                        if paso == 0 {
                            if ej == 0 {
                                self.aplicar(
                                    "E1-03",
                                    "Ejemplos asistidos: Aule recuerda la secuencia, el Alumno ejecuta",
                                );
                            }
                            out.push(
                                msg(format!("Te acompaño paso a paso. {}", x.enunciado)).adj(
                                    Adjunto::Secuencia {
                                        pasos: x.secuencia.clone(),
                                    },
                                ),
                            );
                        }
                        out.push(msg(x.pasos[paso].indicacion.clone()));
                    }
                    FaseE1::Explicar { .. } => {
                        self.aplicar(
                            "E1-04",
                            "Para completar la Etapa 1: explicar el tema con sus palabras",
                        );
                        out.push(msg(format!(
                            "¡Muy bien! Para terminar esta etapa: {}",
                            c.etapa1.explicar.pregunta
                        )));
                    }
                }
            }
            Actividad::Etapa2(e2) => {
                self.revisar_aviso(out);
                // [PROPUESTA] E2-02: si puede terminar antes, no se dice el total.
                let texto = if self.e2_puede_terminar_antes(e2.lista.len()) {
                    format!("Ejercicio {}.", e2.idx + 1)
                } else {
                    format!("Ejercicio {} de {}.", e2.idx + 1, e2.lista.len())
                };
                out.push(msg(texto));
            }
            Actividad::Practica(p) => {
                self.revisar_aviso(out);
                let nombre = match p.modo {
                    ModoPractica::Tarea => "Ejercicio",
                    ModoPractica::Simulacion => "Pregunta",
                    ModoPractica::Correccion => "Pregunta",
                };
                out.push(msg(format!("{nombre} {} de {}.", p.idx + 1, p.items.len())));
            }
            // También al volver de una pausa: se pide otra vez.
            Actividad::PedirTarea { tras_tamizaje, .. } => {
                out.push(msg(pedir_tarea(tras_tamizaje)));
            }
            _ => {}
        }
    }

    // ─────────── vista ───────────

    /// ¿El chat general es conversación libre ahora? (En los momentos de conversación
    /// guiada, como la teoría o la bienvenida, el texto sigue moviendo el flujo.)
    pub fn chat_libre(&self) -> bool {
        match &self.act {
            Actividad::Tamizaje(_)
            | Actividad::Etapa2(_)
            | Actividad::Practica(_)
            | Actividad::Pausa(_)
            | Actividad::Terminada => true,
            Actividad::Etapa1(e) => {
                matches!(e.fase, FaseE1::Asistido { .. } | FaseE1::Explicar { .. })
            }
            _ => false,
        }
    }

    /// En los momentos de conversación guiada, ¿este texto mueve el flujo? ("sigue",
    /// "no entendí", una fecha, un tema…). Si no, es conversación libre y no avanza nada.
    pub fn texto_es_flujo(&self, t: &str) -> bool {
        let n = normalizar(t);
        let palabras_avance = [
            "sigue",
            "sigamos",
            "seguimos",
            "siguiente",
            "continua",
            "continuemos",
            "entendido",
            "entendi",
            "listo",
            "ok",
            "okay",
            "vale",
            "dale",
            "ya",
            "si",
            "claro",
            "perfecto",
            "vamos",
            "empecemos",
            "adelante",
        ];
        let es_avance = n.split_whitespace().count() <= 4
            && n.split_whitespace().any(|w| palabras_avance.contains(&w))
            && !n.contains("no entend");
        // E1-06: quien empieza asintiendo y sigue hablando también avanza.
        let asiente = empieza_asintiendo(t, &palabras_avance);
        let sugerida = match self.esperando() {
            Esperando::Conversacion { sugerencias } => {
                sugerencias.iter().any(|s| normalizar(s) == n)
            }
            _ => false,
        };
        match &self.act {
            Actividad::Etapa1(e) if matches!(e.fase, FaseE1::Teoria(_) | FaseE1::NoAsistido(_)) => {
                sugerida
                    || es_avance
                    || asiente
                    || n.contains("no entend")
                    || n.contains("otra vez")
                    || n.contains("repite")
                    // «¿Seguimos?» · «No»: lo toma el motor, que explica otra vez.
                    || n == "no"
            }
            _ => true,
        }
    }

    /// Contexto para que la IA converse sabiendo qué puede y qué no puede hacer.
    pub fn contexto_chat(&self) -> crate::conversacion::ContextoChat {
        let v = self.vista();
        let interes = self.interes();
        let (enunciado, hay_pistas, sin_ayuda) = match &self.act {
            Actividad::Tamizaje(t) => (
                Some(t.actual.enunciado_para(interes.as_deref()).to_string()),
                false,
                true,
            ),
            Actividad::Etapa2(e) => (
                Some(e.actual.ej.enunciado_para(interes.as_deref()).to_string()),
                true,
                false,
            ),
            Actividad::Practica(p) => (
                Some(p.actual.ej.enunciado_para(interes.as_deref()).to_string()),
                p.modo != ModoPractica::Simulacion,
                p.modo == ModoPractica::Simulacion,
            ),
            Actividad::Etapa1(_) => (
                v.tarjeta.as_ref().map(|t| {
                    let n = t
                        .nota
                        .clone()
                        .map(|n| format!(" ({n})"))
                        .unwrap_or_default();
                    format!("{}{n}", t.enunciado)
                }),
                matches!(&self.act, Actividad::Etapa1(e) if matches!(e.fase, FaseE1::Asistido { .. } | FaseE1::Explicar { .. })),
                false,
            ),
            _ => (None, false, false),
        };
        crate::conversacion::ContextoChat {
            momento: format!("{} {}", v.etapa, v.progreso).trim().to_string(),
            enunciado,
            hay_pistas,
            sin_ayuda,
            en_tamizaje: matches!(self.act, Actividad::Tamizaje(_)),
            en_pausa: matches!(self.act, Actividad::Pausa(_)),
            pausa_restante_s: v.pausa.as_ref().map(|p| p.restante_s),
            terminada: self.terminada(),
        }
    }

    /// Efecto de un mensaje libre del chat. Aclarar vocabulario no es pista ni toca métricas.
    fn chat(&mut self, texto: &str, i: crate::conversacion::Intencion, out: &mut Vec<Mensaje>) {
        use crate::conversacion::Intencion as I;
        self.aplicar(
            "CHAT",
            &format!("Mensaje libre del Alumno · intención: {}", i.nombre()),
        );
        // SES-07: después del aviso, si dice una fecha para otra sesión, se anota.
        let n = normalizar(texto);
        if self.aviso_dado && (n.contains("sesion") || n.contains("clase")) {
            if let FechaDicha::Fecha(f) = leer_fecha(texto, self.perfil.hoy) {
                self.sesion_adicional = Some(fecha_larga(f));
                self.aplicar("SES-07", "El Alumno pidió una sesión adicional");
                out.push(msg(format!(
                    "¡Anotado! Le comento a tus padres que te gustaría una sesión adicional el {}.",
                    fecha_larga(f)
                )));
                return;
            }
        }
        if matches!(i, I::PedirAyuda | I::PedirRespuesta) {
            let con_pistas = match &self.act {
                Actividad::Etapa2(_) => true,
                Actividad::Practica(p) => p.modo != ModoPractica::Simulacion,
                Actividad::Etapa1(e) => {
                    matches!(e.fase, FaseE1::Asistido { .. } | FaseE1::Explicar { .. })
                }
                _ => false,
            };
            if con_pistas {
                // Igual que el botón "Necesito ayuda": el sistema de pistas (PIS-01).
                self.ayuda(out);
            }
        }
        if i == I::AclararPalabra {
            self.aplicar(
                "CHAT",
                "Aclarar vocabulario del enunciado (pedido por Cesar, 2026-11-15): no cuenta como pista",
            );
        }
        self.contar_charla_de_explicacion(out);
        self.contar_charla_de_pregunta(out);
    }

    /// [PROPUESTA] CHAT-02. Conversar mientras el motor espera una respuesta no
    /// la trae, y a quien se le oye mal («Dos» oído «Doce») se queda ahí sin
    /// saberlo: por voz, la conversación con el modelo dio catorce vueltas con
    /// el ejercicio esperando. A la tercera vez seguida
    /// (`Config::charlas_por_pregunta`) el motor vuelve a decir lo que espera:
    /// el enunciado, o la pregunta de la explicación.
    fn contar_charla_de_pregunta(&mut self, out: &mut Vec<Mensaje>) {
        // Si el motor ya contestó este mensaje (una pista, seguir con lo
        // siguiente), lo que espera ya quedó dicho otra vez.
        if !out.is_empty() {
            self.charlas_pregunta = 0;
            return;
        }
        let pregunta = match self.esperando() {
            Esperando::Respuesta { enunciado, .. } => enunciado,
            Esperando::Explicacion { pregunta, .. } => pregunta,
            _ => return,
        };
        self.charlas_pregunta = self.charlas_pregunta.saturating_add(1);
        let tope = self.cfg.charlas_por_pregunta;
        if tope == 0 || self.charlas_pregunta < tope {
            return;
        }
        self.charlas_pregunta = 0;
        self.aplicar(
            "CHAT-02",
            &format!(
                "{tope} turnos de conversación seguidos con una respuesta pendiente: el motor repite su pregunta"
            ),
        );
        out.push(msg(pregunta));
    }

    /// [PROPUESTA] Conversar sobre una explicación o un ejemplo resuelto no los
    /// hace avanzar: quien conteste otra cosa que «sí» se quedaría ahí toda la
    /// sesión. A la tercera vez seguida (`Config::charlas_por_explicacion`) el
    /// motor sigue con lo siguiente por su cuenta, como al esperar la foto.
    fn contar_charla_de_explicacion(&mut self, out: &mut Vec<Mensaje>) {
        // Si el motor ya contestó este mensaje, no fue conversación libre.
        if !out.is_empty() {
            return;
        }
        let Actividad::Etapa1(e1) = self.act.clone() else {
            return;
        };
        if !matches!(e1.fase, FaseE1::Teoria(_) | FaseE1::NoAsistido(_)) {
            return;
        }
        self.charlas_explicacion = self.charlas_explicacion.saturating_add(1);
        let tope = self.cfg.charlas_por_explicacion;
        if tope == 0 || self.charlas_explicacion < tope {
            return;
        }
        self.aplicar(
            "E1-06",
            &format!(
                "{} turnos de conversación sobre la misma explicación: se sigue con lo siguiente",
                self.charlas_explicacion
            ),
        );
        out.push(msg("Sigamos, y lo vas a ver en lo que viene."));
        self.seguir_e1(e1, out);
    }

    pub fn esperando(&self) -> Esperando {
        let resp = |e: &Ejercicio, enun: String| Esperando::Respuesta {
            enunciado: enun,
            respuesta: e.respuesta.clone(),
            opciones: e.opciones.clone(),
            forma: e.forma,
            pide_explicacion: e.pide_explicacion,
            criterio: e.criterio_explicacion.clone(),
            claves: e.claves_explicacion.clone(),
            minimo_claves: e.minimo_claves,
        };
        let interes = self.interes();
        match &self.act {
            Actividad::NoIniciada => Esperando::Nada,
            Actividad::PedirFecha(_) => Esperando::Conversacion {
                sugerencias: vec![
                    "Mañana".into(),
                    "El jueves".into(),
                    "El viernes".into(),
                    "No hay fecha".into(),
                ],
            },
            Actividad::Bienvenida => Esperando::Conversacion {
                sugerencias: vec!["¡Listo, empecemos!".into()],
            },
            Actividad::ElegirTema { .. } => Esperando::Conversacion {
                sugerencias: vec![
                    format!("Sí, {}", self.tema_principal().to_lowercase()),
                    self.sugerencia_interes(),
                    "Prefiero terminar por hoy".into(),
                ],
            },
            Actividad::PedirTarea { .. } => Esperando::FotoTarea,
            Actividad::Tamizaje(t) => resp(
                &t.actual,
                t.actual.enunciado_para(interes.as_deref()).into(),
            ),
            Actividad::Etapa1(e1) => {
                let c = self.banco.nivel(e1.nivel);
                match &e1.fase {
                    FaseE1::Teoria(_) => Esperando::Conversacion {
                        sugerencias: vec!["Entendido, sigue".into(), "No entendí".into()],
                    },
                    FaseE1::NoAsistido(_) => Esperando::Conversacion {
                        sugerencias: vec!["Entendido, sigue".into(), "No entendí".into()],
                    },
                    FaseE1::Asistido { ej, paso, .. } => {
                        let p = &c.etapa1.asistidos[*ej].pasos[*paso];
                        Esperando::Respuesta {
                            enunciado: p.indicacion.clone(),
                            respuesta: p.respuesta.clone(),
                            opciones: p.opciones.clone(),
                            forma: Forma::Cualquiera,
                            pide_explicacion: false,
                            criterio: None,
                            claves: vec![],
                            minimo_claves: 1,
                        }
                    }
                    FaseE1::Explicar { .. } => Esperando::Explicacion {
                        pregunta: c.etapa1.explicar.pregunta.clone(),
                        criterio: c.etapa1.explicar.criterio.clone(),
                        claves: c.etapa1.explicar.claves.clone(),
                        minimo_claves: c.etapa1.explicar.minimo_claves,
                    },
                }
            }
            Actividad::Etapa2(e) => resp(
                &e.actual.ej,
                e.actual.ej.enunciado_para(interes.as_deref()).into(),
            ),
            Actividad::Practica(p) => resp(
                &p.actual.ej,
                p.actual.ej.enunciado_para(interes.as_deref()).into(),
            ),
            Actividad::Pausa(_) => Esperando::Actividad {
                opciones: self
                    .cfg
                    .actividades_pausa
                    .iter()
                    .map(|a| a.nombre.clone())
                    .collect(),
            },
            Actividad::Siguiente | Actividad::Terminada => Esperando::Nada,
        }
    }

    fn tarjeta(&self) -> Option<Tarjeta> {
        let interes = self.interes();
        let ia = interes.as_deref();
        let ej_tarjeta = |modo: Modo,
                          titulo: String,
                          e: &Ejercicio,
                          nota: Option<String>,
                          pistas: bool| {
            let enunciado = e.enunciado_para(ia).to_string();
            let ayuda_formato = e.opciones.is_empty().then(|| {
                crate::formato::ayuda(&e.respuesta, &[&enunciado, nota.as_deref().unwrap_or("")])
            });
            Tarjeta {
                modo,
                titulo,
                enunciado,
                grafico: e.grafico.clone(),
                opciones: e.opciones.clone(),
                pide_respuesta: true,
                pide_explicacion: e.pide_explicacion,
                es_ejercicio: true,
                nota,
                id: Some(e.id.clone()),
                permite_pistas: pistas,
                ayuda_formato,
            }
        };
        match &self.act {
            Actividad::Tamizaje(t) => Some(ej_tarjeta(
                Modo::Tamizaje,
                format!(
                    "Tamizaje · Pregunta {} de {}",
                    t.nivel, self.cfg.niveles_por_tema
                ),
                &t.actual,
                Some("Escribe tu respuesta y cuéntame cómo lo pensaste.".into()),
                false,
            )),
            Actividad::Etapa2(e) => Some(ej_tarjeta(
                Modo::Etapa2,
                format!(
                    "Etapa 2: Refuerzo · Ejercicio {} de {}",
                    e.idx + 1,
                    e.lista.len()
                ),
                &e.actual.ej,
                None,
                true,
            )),
            Actividad::Practica(p) => {
                let (modo, nombre) = match p.modo {
                    ModoPractica::Tarea => (Modo::Tarea, "Tarea · Ejercicio"),
                    ModoPractica::Simulacion => (Modo::Simulacion, "Simulación · Pregunta"),
                    ModoPractica::Correccion => (Modo::Correccion, "Corrección · Pregunta"),
                };
                let it = &p.items[p.idx];
                Some(ej_tarjeta(
                    modo,
                    format!("{nombre} {} de {}", p.idx + 1, p.items.len()),
                    &p.actual.ej,
                    it.nota.clone(),
                    p.modo != ModoPractica::Simulacion,
                ))
            }
            Actividad::Etapa1(e1) => {
                let c = self.banco.nivel(e1.nivel);
                let base =
                    |modo, titulo: String, enunciado: String, grafico: Option<Grafico>| Tarjeta {
                        modo,
                        titulo,
                        enunciado,
                        grafico,
                        opciones: vec![],
                        pide_respuesta: false,
                        pide_explicacion: false,
                        es_ejercicio: false,
                        nota: None,
                        id: None,
                        permite_pistas: false,
                        ayuda_formato: None,
                    };
                Some(match &e1.fase {
                    FaseE1::Teoria(i) => base(
                        Modo::Teoria,
                        format!("Etapa 1: Descubrimiento · {}", c.titulo),
                        c.etapa1.teoria[*i].texto.clone(),
                        c.etapa1.teoria[*i].grafico.clone(),
                    ),
                    FaseE1::NoAsistido(i) => {
                        let x = &c.etapa1.no_asistidos[*i];
                        let mut t = base(
                            Modo::EjemploNoAsistido,
                            format!(
                                "Etapa 1 · Ejemplo resuelto {} de {}",
                                i + 1,
                                c.etapa1.no_asistidos.len()
                            ),
                            x.enunciado.clone(),
                            x.grafico.clone(),
                        );
                        t.nota = Some(
                            x.pasos
                                .iter()
                                .enumerate()
                                .map(|(k, p)| format!("{}. {p}", k + 1))
                                .collect::<Vec<_>>()
                                .join("\n"),
                        );
                        t
                    }
                    FaseE1::Asistido { ej, paso, .. } => {
                        let x = &c.etapa1.asistidos[*ej];
                        let p = &x.pasos[*paso];
                        let mut t = base(
                            Modo::EjemploAsistido,
                            format!(
                                "Etapa 1 · Ejemplo guiado {} de {} · Paso {} de {}",
                                ej + 1,
                                c.etapa1.asistidos.len(),
                                paso + 1,
                                x.pasos.len()
                            ),
                            x.enunciado.clone(),
                            x.grafico.clone(),
                        );
                        t.nota = Some(p.indicacion.clone());
                        t.opciones = p.opciones.clone();
                        t.pide_respuesta = true;
                        if p.opciones.is_empty() {
                            t.ayuda_formato = Some(crate::formato::ayuda(
                                &p.respuesta,
                                &[&x.enunciado, &p.indicacion],
                            ));
                        }
                        t
                    }
                    FaseE1::Explicar { .. } => {
                        let mut t = base(
                            Modo::Explicar,
                            "Etapa 1 · Explícalo con tus palabras".into(),
                            c.etapa1.explicar.pregunta.clone(),
                            None,
                        );
                        t.pide_explicacion = true;
                        t.permite_pistas = true;
                        t
                    }
                })
            }
            _ => None,
        }
    }

    pub fn vista(&self) -> Vista {
        let (etapa, progreso) = match &self.act {
            Actividad::NoIniciada => ("Antes de empezar".into(), String::new()),
            Actividad::PedirFecha(_) | Actividad::Bienvenida => {
                ("Objetivo de la sesión".into(), String::new())
            }
            Actividad::ElegirTema { .. } => ("Aprendizaje extracurricular".into(), String::new()),
            Actividad::PedirTarea { .. } => ("Tarea".into(), String::new()),
            Actividad::Tamizaje(t) => (
                "Tamizaje".into(),
                format!("Pregunta {} de {}", t.nivel, self.cfg.niveles_por_tema),
            ),
            Actividad::Etapa1(e) => (
                "Etapa 1: Descubrimiento".into(),
                format!("Nivel {}", e.nivel),
            ),
            Actividad::Etapa2(e) => (
                "Etapa 2: Refuerzo".into(),
                format!(
                    "Nivel {} · Ejercicio {} de {}",
                    e.nivel,
                    e.idx + 1,
                    e.lista.len()
                ),
            ),
            Actividad::Practica(p) => (
                match p.modo {
                    ModoPractica::Tarea => "Tarea".into(),
                    ModoPractica::Simulacion => "Simulación".into(),
                    ModoPractica::Correccion => "Corrección de evaluación".into(),
                },
                format!("{} de {}", p.idx + 1, p.items.len()),
            ),
            Actividad::Pausa(_) => ("Pausa activa".into(), String::new()),
            Actividad::Siguiente => ("…".into(), String::new()),
            Actividad::Terminada => ("Sesión terminada".into(), String::new()),
        };
        let pausa = match &self.act {
            Actividad::Pausa(p) => Some(VistaPausa {
                restante_s: self.pausa_restante_s(p),
                actividad: p
                    .eleccion
                    .and_then(|k| self.cfg.actividades_pausa.get(k).cloned()),
            }),
            _ => None,
        };
        let tema = self.tema_principal();
        let objetivos = self
            .objetivos
            .iter()
            .enumerate()
            .map(|(i, o)| VistaObjetivo {
                tipo: o.tipo.nombre().into(),
                curso: o.curso.clone(),
                tema: if o.tipo == TipoObjetivo::Extracurricular {
                    self.extra_tema
                        .clone()
                        .unwrap_or_else(|| "(lo elige el Alumno)".into())
                } else {
                    o.tema.clone()
                },
                fecha: o.fecha.map(fecha_larga),
                nivel_objetivo: if o.estado == EstadoObjetivo::NoCubierto {
                    None
                } else if o.tipo == TipoObjetivo::Extracurricular {
                    self.extra_objetivo
                } else {
                    Some(self.nivel_objetivo(i))
                },
                estado: format!("{:?}", o.estado),
                actual: self.obj_actual == Some(i),
            })
            .collect();
        let en_ejercicio = matches!(
            self.act,
            Actividad::Etapa2(_) | Actividad::Practica(_) | Actividad::Etapa1(_)
        );
        Vista {
            iniciada: self.iniciada,
            terminada: self.terminada(),
            etapa,
            progreso,
            tarjeta: self.tarjeta(),
            esperando: self.esperando(),
            transcurrido_s: (self.transcurrido_min() * 60.0) as u64,
            pausa,
            regla: self.regla.clone(),
            registro: self.registro.iter().rev().take(60).cloned().collect(),
            niveles: vec![(tema.clone(), self.nivel_de(&tema))],
            objetivos,
            metricas: self.metricas.clone(),
            informe: if self.terminada() {
                Some(self.informe())
            } else {
                None
            },
            boton_ayuda: en_ejercicio || matches!(self.act, Actividad::Tamizaje(_)),
            boton_cansado: self.iniciada
                && !matches!(self.act, Actividad::Pausa(_) | Actividad::Terminada),
            boton_salir_tamizaje: matches!(self.act, Actividad::Tamizaje(_)),
            alumno: self.nombre(),
            proyeccion_min: if self.iniciada {
                self.proyeccion_min()
            } else {
                0.0
            },
            pausas_tomadas: self.pausas_tomadas,
            aviso_dado: self.aviso_dado,
            estimacion_sesiones: self.estimacion_sesiones,
            ruta: self.ruta(),
        }
    }

    /// Para tests y panel: nombre corto de la actividad actual.
    pub fn actividad(&self) -> String {
        match &self.act {
            Actividad::NoIniciada => "no_iniciada".into(),
            Actividad::PedirFecha(_) => "pedir_fecha".into(),
            Actividad::Bienvenida => "bienvenida".into(),
            Actividad::ElegirTema { .. } => "elegir_tema".into(),
            Actividad::PedirTarea { .. } => "pedir_tarea".into(),
            Actividad::Tamizaje(t) => format!("tamizaje:{}", t.nivel),
            Actividad::Etapa1(e) => format!(
                "etapa1:{}:{}",
                e.nivel,
                match e.fase {
                    FaseE1::Teoria(_) => "teoria",
                    FaseE1::NoAsistido(_) => "no_asistido",
                    FaseE1::Asistido { .. } => "asistido",
                    FaseE1::Explicar { .. } => "explicar",
                }
            ),
            Actividad::Etapa2(e) => format!("etapa2:{}:{}", e.nivel, e.idx + 1),
            Actividad::Practica(p) => format!(
                "{}:{}",
                match p.modo {
                    ModoPractica::Tarea => "tarea",
                    ModoPractica::Simulacion => "simulacion",
                    ModoPractica::Correccion => "correccion",
                },
                p.idx + 1
            ),
            Actividad::Pausa(_) => "pausa".into(),
            Actividad::Siguiente => "siguiente".into(),
            Actividad::Terminada => "terminada".into(),
        }
    }

    /// Id del ejercicio en pantalla (tests).
    pub fn ejercicio_actual(&self) -> Option<Ejercicio> {
        match &self.act {
            Actividad::Tamizaje(t) => Some(t.actual.clone()),
            Actividad::Etapa2(e) => Some(e.actual.ej.clone()),
            Actividad::Practica(p) => Some(p.actual.ej.clone()),
            _ => None,
        }
    }

    pub fn registro(&self) -> &[String] {
        &self.registro
    }

    pub fn pausas_tomadas(&self) -> u32 {
        self.pausas_tomadas
    }

    pub fn aviso_dado(&self) -> bool {
        self.aviso_dado
    }

    /// DEMO-15 [PROPUESTA]: lo que se conserva para la sesión siguiente: nivel por
    /// tema, objetivos sin completar y tamizaje incompleto.
    pub fn para_siguiente_sesion(&self) -> (Perfil, Vec<Objetivo>) {
        let mut perfil = self.perfil.clone();
        let mut objetivos: Vec<Objetivo> = self
            .objetivos
            .iter()
            .filter(|o| {
                matches!(
                    o.estado,
                    EstadoObjetivo::Pendiente | EstadoObjetivo::EnCurso
                ) && o.tipo != TipoObjetivo::Extracurricular
            })
            .cloned()
            .collect();
        for o in objetivos.iter_mut() {
            o.estado = EstadoObjetivo::Pendiente;
        }
        // El tamizaje que se estaba haciendo al cerrar también se retoma.
        if let Actividad::Tamizaje(t) = &self.act {
            perfil.tamizaje_parcial.insert(
                t.tema.clone(),
                TamizajeParcial {
                    respuestas: t.respuestas.clone(),
                    retomar_en: t.nivel,
                    usadas: t.usadas.clone(),
                },
            );
        }
        perfil.hoy = self.perfil.proxima_sesion;
        perfil.proxima_sesion = perfil.hoy + chrono::Duration::days(2);
        perfil.numero_sesion += 1;
        perfil.sugerencia_padre = None;
        (perfil, objetivos)
    }

    pub fn objetivos_pendientes(&self) -> Vec<Objetivo> {
        self.objetivos
            .iter()
            .filter(|o| o.estado == EstadoObjetivo::Pendiente)
            .cloned()
            .collect()
    }
}

fn ex_repaso(c: &NivelContenido) -> Vec<crate::banco::BloqueTeoria> {
    c.etapa1.repaso.clone()
}

fn si_no(b: bool) -> &'static str {
    if b {
        "bien"
    } else {
        "mal"
    }
}

fn minutos_y_segundos(s: u64) -> String {
    let (m, s) = (s / 60, s % 60);
    if m == 0 {
        format!("{s} segundos")
    } else if s == 0 {
        format!("{m} minutos")
    } else {
        format!("{m} min {s} s")
    }
}

/// [PROPUESTA] TAR-05: cómo se pide la foto de la Tarea: tras el Tamizaje de
/// hoy, o antes de empezar, con el nivel del Alumno ya conocido.
fn pedir_tarea(tras_tamizaje: bool) -> &'static str {
    if tras_tamizaje {
        "Ahora quiero ver tu tarea, para saber qué practicar. Muéstramela a la cámara, y si no la tienes, dime «no tengo»."
    } else {
        "Antes de empezar, quiero ver tu tarea para saber qué practicar. Muéstramela a la cámara, y si no la tienes, dime «no tengo»."
    }
}

/// [PROPUESTA] TAR-06: «no tengo», «no la traje», «no quiero»: el Alumno no va
/// a mostrar su Tarea. Un «no, espera» no lo es.
fn no_tiene_tarea(t: &str) -> bool {
    let n = normalizar(t);
    n == "no"
        || n == "nop"
        || [
            "no tengo",
            "no la tengo",
            "no lo tengo",
            "no traje",
            "no la traje",
            "no hay tarea",
            "no me dejaron",
            "no nos dejaron",
            "no quiero",
            "no la encuentro",
            "se me olvido",
            "me olvide",
            "la olvide",
            "sin tarea",
        ]
        .iter()
        .any(|p| n.contains(p))
}

/// "Ya volví", "listo", "sigamos": dicho en la pausa, que quiere seguir.
fn dice_que_volvio(t: &str) -> bool {
    let n = normalizar(t);
    [
        "volvi",
        "ya estoy",
        "termine",
        "listo",
        "lista",
        "sigamos",
        "seguimos",
        "continuemos",
    ]
    .iter()
    .any(|p| n.contains(p))
}

#[derive(Clone, Copy, PartialEq)]
enum Disparo {
    Error,
    Ayuda,
    Tiempo,
}

enum ResPista {
    Dada(String),
    Agotada,
}

/// PIS-02 / PIS-03: siguiente pista de la secuencia; luego paso a paso de un similar.
fn dar_pista(cfg: &Config, ex: &mut Ex, por: Disparo, out: &mut Vec<Mensaje>) -> ResPista {
    let orden = &cfg.orden_pistas;
    let pre = match por {
        Disparo::Error => "Te dejo una pregunta para pensar:",
        Disparo::Ayuda => "¡Claro! Te ayudo con una pregunta:",
        Disparo::Tiempo => "Veo que este te está tomando un ratito, es normal. Te dejo una ayuda:",
    };
    if ex.pistas < orden.len() {
        let socr_previas = orden[..ex.pistas]
            .iter()
            .filter(|t| **t == TipoPista::Socratica)
            .count();
        let k = ex.pistas;
        ex.pistas += 1;
        match orden[k] {
            TipoPista::Socratica => {
                let p = ex
                    .ej
                    .pistas
                    .get(socr_previas)
                    .cloned()
                    .unwrap_or_else(|| "¿Qué te pide exactamente el ejercicio?".into());
                out.push(msg(format!("{pre} {p}")).clase(Clase::Pista));
                ResPista::Dada(format!("pista socrática {}", socr_previas + 1))
            }
            TipoPista::Grafica => {
                let m = match &ex.ej.pista_grafica {
                    Some(pg) => msg(format!("Mira este dibujo: {}", pg.texto)).adj(Adjunto::Grafico {
                        grafico: pg.grafico.clone(),
                    }),
                    None => msg("Haz un dibujo en tu cuaderno: parte una barra en partes iguales y pinta lo que dice el ejercicio."),
                };
                out.push(m.clase(Clase::Pista));
                ResPista::Dada("pista gráfica".into())
            }
        }
    } else if !ex.paso_a_paso {
        ex.paso_a_paso = true;
        match &ex.ej.similar {
            Some(s) => {
                out.push(
                    msg("Te muestro el paso a paso de un ejercicio similar. Mira bien los pasos y luego intenta el tuyo.")
                        .clase(Clase::Pista)
                        .adj(Adjunto::Pasos {
                            titulo: "Paso a paso de un ejercicio similar".into(),
                            enunciado: s.enunciado.clone(),
                            pasos: s.pasos.clone(),
                            grafico: s.grafico.clone(),
                        }),
                );
            }
            None => out.push(
                msg("Vuelve a leer el ejercicio despacito, parte por parte.").clase(Clase::Pista),
            ),
        }
        ResPista::Dada("paso a paso de un ejercicio similar (PIS-03)".into())
    } else if por == Disparo::Error {
        ResPista::Agotada
    } else {
        out.push(
            msg("Ya vimos el paso a paso de uno parecido. Usa esos mismos pasos con los números de tu ejercicio. ¡Tú puedes!")
                .clase(Clase::Calma),
        );
        ResPista::Dada("recordatorio del paso a paso".into())
    }
}
