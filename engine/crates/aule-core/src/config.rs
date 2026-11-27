//! Todos los números de las reglas viven aquí (nada hardcodeado en el motor).
//! Cada campo lleva el ID de la regla. [PROPUESTA] = aún sin confirmar por Cesar.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TipoPista {
    Socratica,
    Grafica,
}

/// PAU-06: para qué sirve una actividad de la pausa activa.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TipoPausa {
    /// Para quien está somnoliento o aburrido.
    Energizante,
    /// Para quien está ansioso, frustrado o cansado.
    Relajante,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActividadPausa {
    pub nombre: String,
    pub tipo: TipoPausa,
    pub para: String,
    pub pasos: Vec<String>,
    /// [PROPUESTA] Palabras con las que el Alumno la elige al hablar, además de
    /// por su nombre («respir», «globo»). Se comparan sin tildes ni mayúsculas.
    #[serde(default)]
    pub palabras: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    /// SES-01: duración mínima de la sesión (minutos).
    pub sesion_minima_min: u32,
    /// SES-01: duración recomendada.
    pub sesion_recomendada_min: u32,
    /// SES-01: duración máxima.
    pub sesion_maxima_min: u32,
    /// SES-05: avisos con anticipación (en ejercicios) según la duración proyectada.
    /// Hasta `sesion_minima_min` no se avisa.
    pub aviso_hasta_recomendada: u32,
    pub aviso_hasta_maxima: u32,
    /// SES-06: si el objetivo no se completa en la sesión, avisa faltando n ejercicios.
    pub aviso_no_completa: u32,
    /// SES-05 [PROPUESTA]: usar la duración proyectada (transcurrido + promedio de lo que falta).
    pub usar_duracion_proyectada: bool,
    /// Factor sobre los tiempos promedio del contenido para proyectar (los tiempos son referenciales).
    pub factor_tiempo: f64,

    /// PAU-01..03: minutos en los que entra cada pausa activa.
    pub pausas_en_min: Vec<u32>,
    /// PAU-06: duración de la pausa activa (segundos).
    pub pausa_duracion_s: u64,
    /// PAU-06 [PROPUESTA]: las 4 actividades (2 energizantes y 2 relajantes).
    pub actividades_pausa: Vec<ActividadPausa>,
    /// PAU-07 [PROPUESTA]: de qué minuto del día a cuál es de noche donde vive
    /// la familia. De noche, quien dice que está cansado descansa: la sesión se
    /// cierra en vez de proponer una pausa activa.
    pub noche_desde_min: u16,
    pub noche_hasta_min: u16,

    /// NIV-01: niveles por tema.
    pub niveles_por_tema: u8,
    /// TAM-01: duración estimada del tamizaje (minutos), para proyectar.
    pub tamizaje_min_estimados: u32,

    /// E1-02: duración estimada de la Etapa 1 (entre 5 y 10 minutos).
    pub etapa1_min_estimados: u32,
    /// E2-01: ejercicios autónomos de la Etapa 2.
    pub etapa2_ejercicios: usize,
    /// E2-02 [PROPUESTA]: la Etapa 2 termina antes si los últimos n ejercicios
    /// salieron bien al primer intento y sin pistas (lo que mide MET-01).
    /// 0 = siempre todos los ejercicios.
    pub etapa2_aciertos_seguidos: usize,

    /// PIS-02: orden de las pistas (2 socráticas y verbales, luego 1 gráfica).
    pub orden_pistas: Vec<TipoPista>,
    /// PIS-01 [PROPUESTA]: disparar pista si se pasa del tiempo promedio. Sin tiempo cargado queda apagado.
    pub pista_por_tiempo: bool,
    /// Multiplicador del tiempo promedio para el disparador por tiempo.
    pub pista_tiempo_factor: f64,

    /// PRE-08: ejercicios por tema (subtema/nivel) en la simulación.
    pub simulacion_por_tema: usize,
    /// Cuántos niveles por debajo del objetivo entran en la simulación (0 = solo el nivel objetivo).
    pub simulacion_niveles_atras: u8,

    /// MET-05 / PRE-02: minutos por nivel sin historial (1 nivel por sesión de 1 hora).
    pub minutos_por_nivel_inicial: u32,
    /// Duración de una sesión para estimar cantidad de sesiones (PRE-02).
    pub minutos_por_sesion_plan: u32,

    /// OBJ-11 / SES-02 / RUT-05..08: umbral de 30 minutos.
    pub umbral_extracurricular_min: u32,

    /// Veces que se repite el ciclo de pistas en Tarea/Corrección antes de dejar el ejercicio marcado.
    pub ciclos_max_tarea: u32,

    /// TAR-05 [PROPUESTA]: con la Tarea como objetivo y su nivel por conocer,
    /// Aule pide verla a la cámara y su nivel es el Nivel objetivo. Apagado:
    /// la Tarea del banco, como hasta ahora. Lo enciende quien puede leer una foto.
    pub foto_tarea: bool,
    /// TAR-06 [PROPUESTA]: una lectura con menos confianza que esta (0 a 100)
    /// cuenta como una foto que no se vio bien.
    pub confianza_minima_foto: u8,
    /// TAR-06 [PROPUESTA]: fotos fallidas tras las que se sigue sin la foto.
    pub intentos_foto: u8,
    /// TAR-06 [PROPUESTA]: turnos de conversación sin foto tras los que se sigue sin ella.
    pub charlas_sin_foto: u8,
    /// E1 [PROPUESTA]: turnos de conversación seguidos sobre una misma explicación
    /// o ejemplo resuelto tras los que el motor sigue con lo siguiente.
    pub charlas_por_explicacion: u8,
    /// CHAT-02 [PROPUESTA]: turnos de conversación seguidos, con una respuesta
    /// pendiente, tras los que el motor vuelve a decir su pregunta. 0: nunca.
    pub charlas_por_pregunta: u8,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            sesion_minima_min: 30,
            sesion_recomendada_min: 60,
            sesion_maxima_min: 90,
            aviso_hasta_recomendada: 2,
            aviso_hasta_maxima: 3,
            aviso_no_completa: 3,
            usar_duracion_proyectada: true,
            factor_tiempo: 1.0,
            pausas_en_min: vec![30, 60],
            pausa_duracion_s: 300,
            actividades_pausa: actividades_propuestas(),
            noche_desde_min: 21 * 60,
            noche_hasta_min: 6 * 60,
            niveles_por_tema: 5,
            tamizaje_min_estimados: 15,
            etapa1_min_estimados: 8,
            etapa2_ejercicios: 5,
            etapa2_aciertos_seguidos: 3,
            orden_pistas: vec![
                TipoPista::Socratica,
                TipoPista::Socratica,
                TipoPista::Grafica,
            ],
            pista_por_tiempo: true,
            pista_tiempo_factor: 1.0,
            simulacion_por_tema: 2,
            simulacion_niveles_atras: 2,
            minutos_por_nivel_inicial: 60,
            minutos_por_sesion_plan: 60,
            umbral_extracurricular_min: 30,
            ciclos_max_tarea: 2,
            foto_tarea: false,
            confianza_minima_foto: 70,
            intentos_foto: 2,
            charlas_sin_foto: 3,
            charlas_por_explicacion: 3,
            charlas_por_pregunta: 3,
        }
    }
}

/// [PROPUESTA] Cesar no definió las 4 actividades de la pausa activa.
pub fn actividades_propuestas() -> Vec<ActividadPausa> {
    let a = |n: &str, t: TipoPausa, p: &str, palabras: &[&str], pasos: &[&str]| ActividadPausa {
        nombre: n.into(),
        tipo: t,
        para: p.into(),
        pasos: pasos.iter().map(|s| s.to_string()).collect(),
        palabras: palabras.iter().map(|s| s.to_string()).collect(),
    };
    vec![
        a(
            "Saltos de estrella",
            TipoPausa::Energizante,
            "Si te falta energía",
            &["salto"],
            &[
                "Ponte de pie, con espacio a tu alrededor.",
                "Haz 15 saltos abriendo brazos y piernas como una estrella.",
                "Descansa 20 segundos y haz otros 15.",
                "Termina estirando los brazos bien arriba.",
            ],
        ),
        a(
            "Espejo de movimientos",
            TipoPausa::Energizante,
            "Si estás aburrido",
            &["aburr", "espejo"],
            &[
                "Ponte de pie frente a la pantalla.",
                "Toca tu nariz, tus rodillas y tus hombros, cada vez más rápido.",
                "Ahora inventa tú un movimiento y repítelo 5 veces.",
                "Sacude manos y pies por 10 segundos.",
            ],
        ),
        a(
            "Respiración del globo",
            TipoPausa::Relajante,
            "Si estás nervioso",
            &["nervios", "ansios", "respir", "globo"],
            &[
                "Siéntate cómodo y pon las manos en tu barriga.",
                "Toma aire por la nariz contando 1, 2, 3, 4: tu barriga se infla como un globo.",
                "Suelta el aire por la boca contando hasta 6, despacito.",
                "Repítelo 5 veces.",
            ],
        ),
        a(
            "Estiramiento del gato",
            TipoPausa::Relajante,
            "Si estás frustrado",
            &["frustr", "molest", "estir", "gato"],
            &[
                "Junta tus manos y estira los brazos hacia adelante, redondeando la espalda.",
                "Ahora llévalos hacia arriba y estírate como un gato que despierta.",
                "Gira despacio el cuello hacia un lado y hacia el otro.",
                "Toma un vaso de agua si tienes a la mano.",
            ],
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn una_actividad_se_guarda_y_se_lee_como_antes() {
        // El tipo se escribe en minúsculas, como cuando era un texto, y una
        // actividad guardada sin palabras se sigue leyendo.
        let vieja =
            r#"{"nombre":"Respirar","tipo":"relajante","para":"Si estás nervioso","pasos":[]}"#;
        let leida: ActividadPausa = serde_json::from_str(vieja).unwrap();
        assert_eq!(leida.tipo, TipoPausa::Relajante);
        assert!(leida.palabras.is_empty());
        let escrita = serde_json::to_value(&actividades_propuestas()[0]).unwrap();
        assert_eq!(escrita["tipo"], "energizante");
    }

    #[test]
    fn las_actividades_propuestas_traen_sus_palabras_y_hay_de_los_dos_tipos() {
        let actividades = actividades_propuestas();
        assert!(actividades.iter().all(|a| !a.palabras.is_empty()));
        for tipo in [TipoPausa::Energizante, TipoPausa::Relajante] {
            assert!(actividades.iter().any(|a| a.tipo == tipo), "{tipo:?}");
        }
    }
}
