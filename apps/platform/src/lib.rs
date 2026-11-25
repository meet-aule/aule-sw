//! Aule's platform. One crate, two processes: the API (`serve`) and the
//! worker (`worker`). ARCHITECTURE.md at the repository root has the design.

pub mod algebra;
pub mod auth;
pub mod config;
pub mod devices;
pub mod engine;
pub mod entity;
pub mod error;
pub mod events;
pub mod exercise;
pub mod families;
pub mod google;
pub mod http;
pub mod jobs;
pub mod learning;
pub mod livekit;
pub mod llm;
pub mod mail;
pub mod memory;
pub mod metrics;
pub mod notices;
pub mod oauth;
pub mod plans;
pub mod practice;
pub mod push;
pub mod sessions;
pub mod signin;
pub mod state;
pub mod supervisor;
pub mod team;

/// The platform's version: Cargo.toml's, which `scripts/version.py` keeps
/// equal to the repository's version.txt.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// How the platform names its build: `aule-platform 0.0.1 (abc123456789)`.
pub fn version_line(commit: &str) -> String {
    format!("aule-platform {VERSION} ({commit})")
}

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// The migration that replaced 0001 to 0016 (see `migrations/0017_baseline.sql`).
pub const BASELINE: i64 = 17;
/// Held while deciding and migrating, so the API and the worker starting
/// together do one migration, not two.
const MIGRATE_LOCK: i64 = 0x6175_6c65_6d69_6772; // "aulemigr"

#[derive(Debug, thiserror::Error)]
pub enum MigrateError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error(
        "this database predates migration 16 (it has {0} of migrations 1 to 16): restore it with the \
         `pre-baseline` image, start that once to bring it to 16, back it up, then restore that backup"
    )]
    PredatesBaseline(usize),
}

/// Brings the database up to date. An empty one runs the baseline and what
/// follows. One that ran 0001 to 0016 before they were collapsed (the server's,
/// or any backup taken before) is marked as having run the baseline instead,
/// with its schema untouched, and then migrated as usual.
pub async fn migrate(pool: &sqlx::PgPool) -> Result<(), MigrateError> {
    let mut connection = pool.acquire().await?;
    sqlx::query("select pg_advisory_lock($1)").bind(MIGRATE_LOCK).execute(&mut *connection).await?;
    let result = async {
        // Read after taking the lock: another process may have just done it.
        let applied: Vec<(i64, bool)> = match sqlx::query_as::<_, (i64, bool)>(
            "select version, success from _sqlx_migrations order by version",
        )
        .fetch_all(&mut *connection)
        .await
        {
            Ok(rows) => rows,
            // No table yet: an empty database.
            Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("42P01") => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        let legacy: Vec<i64> = applied.iter().map(|(version, _)| *version).filter(|v| *v < BASELINE).collect();
        let has_baseline = applied.iter().any(|(version, _)| *version == BASELINE);
        if !legacy.is_empty() && !has_baseline {
            let complete = legacy == (1..BASELINE).collect::<Vec<_>>() && applied.iter().all(|(_, ok)| *ok);
            if !complete {
                return Err(MigrateError::PredatesBaseline(legacy.len()));
            }
            let baseline = MIGRATOR
                .iter()
                .find(|migration| migration.version == BASELINE)
                .expect("the baseline is one of the migrations");
            let mut tx = sqlx::Connection::begin(&mut *connection).await?;
            sqlx::query("delete from _sqlx_migrations where version < $1").bind(BASELINE).execute(&mut *tx).await?;
            sqlx::query(
                "insert into _sqlx_migrations (version, description, installed_on, success, checksum, execution_time)
                 values ($1, $2, now(), true, $3, 0)",
            )
            .bind(BASELINE)
            .bind(baseline.description.as_ref())
            .bind(baseline.checksum.as_ref())
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            tracing::info!("migrations 1 to 16 are now the baseline");
        }
        MIGRATOR.run(&mut *connection).await?;
        Ok(())
    }
    .await;
    // Unlocked whatever happened; a lost connection drops the lock by itself.
    let _ = sqlx::query("select pg_advisory_unlock($1)").bind(MIGRATE_LOCK).execute(&mut *connection).await;
    result
}
