//! What every request handler and job can reach.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::google::{Google, IdentityProvider};
use crate::livekit::{LiveKitRooms, Rooms};
use crate::llm::{Anthropic, Llm};
use crate::mail::{Mailer, SmtpMailer};
use crate::memory::{Embedder, HttpEmbedder};
use crate::oauth::{Apple, CodeProvider, Github, Meta};
use crate::push::{Fcm, Pusher, ServiceAccount};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    /// The same pool, for the code that goes through SeaORM.
    pub db: sea_orm::DatabaseConnection,
    pub config: Arc<Config>,
    /// Opens sessions' rooms. Without LiveKit settings no session can start.
    pub rooms: Option<Arc<dyn Rooms>>,
    /// The supervisor's model. Without one, plans come from the learner model
    /// alone and there is no guidance or review.
    pub llm: Option<Arc<dyn Llm>>,
    pub embedder: Option<Arc<dyn Embedder>>,
    /// Without one nobody can sign in and notices are only shown in the app.
    pub mailer: Option<Arc<dyn Mailer>>,
    /// Without one, notices reach a guardian in the app and by email only.
    pub pusher: Option<Arc<dyn Pusher>>,
    /// Without one, guardians sign in with an emailed code only.
    pub google: Option<Arc<dyn IdentityProvider>>,
    pub github: Option<Arc<dyn CodeProvider>>,
    pub meta: Option<Arc<dyn CodeProvider>>,
    pub apple: Option<Arc<dyn CodeProvider>>,
    /// Sessions the supervisor is reading right now, so a burst of turns
    /// starts one reading, not one per turn.
    pub watching: Arc<Mutex<HashSet<Uuid>>>,
    /// Wrong device codes typed by each guardian in the current hour.
    pub claim_attempts: Arc<Mutex<HashMap<Uuid, (u32, std::time::Instant)>>>,
    /// The engines of the sessions the session engine runs. Each can be
    /// rebuilt from the database, so losing this loses nothing.
    pub engines: crate::engine::Engines,
    /// The team console's relying party, for its passkeys. None only if the
    /// library refused the settings config.rs accepted (logged): passkeys
    /// then answer 503, and the emailed code still works.
    pub webauthn: Option<Arc<webauthn_rs::Webauthn>>,
}

impl AppState {
    pub fn new(pool: PgPool, config: Config) -> Self {
        let db = sea_orm::SqlxPostgresConnector::from_sqlx_postgres_pool(pool.clone());
        let rooms =
            config.livekit.clone().map(|livekit| Arc::new(LiveKitRooms::new(livekit)) as Arc<dyn Rooms>);
        let llm = config
            .supervisor
            .clone()
            .map(|settings| Arc::new(Anthropic::new(settings).with_usage(db.clone())) as Arc<dyn Llm>);
        let embedder = config
            .embeddings
            .clone()
            .map(|settings| Arc::new(HttpEmbedder::new(settings)) as Arc<dyn Embedder>);
        let mailer = config.mail.clone().and_then(|settings| match SmtpMailer::new(&settings) {
            Ok(mailer) => Some(Arc::new(mailer) as Arc<dyn Mailer>),
            Err(error) => {
                tracing::error!(%error, "mail is off: the SMTP settings could not be used");
                None
            }
        });
        let pusher = config.fcm_service_account.as_deref().and_then(|path| {
            let account = std::fs::read_to_string(path)
                .map_err(|error| error.to_string())
                .and_then(|text| {
                    serde_json::from_str::<ServiceAccount>(&text).map_err(|error| error.to_string())
                })
                .and_then(|account| Fcm::new(account).map_err(|error| error.to_string()));
            match account {
                Ok(fcm) => Some(Arc::new(fcm) as Arc<dyn Pusher>),
                Err(error) => {
                    tracing::error!(%error, "push is off: AULE_FCM_SERVICE_ACCOUNT could not be used");
                    None
                }
            }
        });
        let google =
            config.google_client_id.clone().map(|id| Arc::new(Google::new(id)) as Arc<dyn IdentityProvider>);
        let github = config
            .github
            .clone()
            .map(|app| Arc::new(Github::new(app.client_id, app.client_secret)) as Arc<dyn CodeProvider>);
        let meta = config
            .meta
            .clone()
            .map(|app| Arc::new(Meta::new(app.client_id, app.client_secret)) as Arc<dyn CodeProvider>);
        // The settings already checked the key, so this only fails if that check is wrong.
        let apple = config.apple.clone().and_then(|apple| {
            Apple::new(apple.services_id, apple.team_id, apple.key_id, &apple.key_pem)
                .inspect_err(
                    |error| tracing::error!(%error, "sign-in with Apple is off: its key could not be used"),
                )
                .ok()
                .map(|apple| Arc::new(apple) as Arc<dyn CodeProvider>)
        });
        let webauthn = crate::passkeys::relying_party(&config.admin_passkeys)
            .inspect_err(
                |error| tracing::error!(%error, "passkeys are off: the relying party could not be made"),
            )
            .ok()
            .map(Arc::new);
        Self {
            db,
            pool,
            config: Arc::new(config),
            rooms,
            llm,
            embedder,
            mailer,
            pusher,
            google,
            github,
            meta,
            apple,
            watching: Arc::default(),
            claim_attempts: Arc::default(),
            engines: Arc::default(),
            webauthn,
        }
    }
}
