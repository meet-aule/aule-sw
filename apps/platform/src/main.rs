//! `aule-platform serve` runs the API, `worker` runs the jobs, `migrate`
//! only brings the database up to date, and `import-skills <file>` loads a
//! skill catalog such as `curriculum/math-primaria.json`. `serve` and `worker`
//! also migrate first, so one of them is enough to start from an empty database,
//! and `serve` loads the catalogs the image carries, so a new or restored
//! server has the same skills as the repository. `version` (or `--version`)
//! prints which build this is and needs nothing else.

use aule_platform::config::{self, Config};
use aule_platform::state::AppState;
use aule_platform::{http, jobs, learning};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

#[derive(serde::Deserialize)]
struct SkillFile {
    skills: Vec<learning::Skill>,
}

/// Where the image puts `curriculum/*.json`. Absent outside the image (a
/// local run), and then nothing is loaded.
const CURRICULUM_DIR: &str = "/usr/share/aule/curriculum";

/// Loads every catalog in `CURRICULUM_DIR`: new skills are added and changed
/// ones updated; none is removed. A catalog that cannot be read is reported
/// and skipped, so a bad file never keeps the API from starting.
async fn load_curriculum(db: &sea_orm::DatabaseConnection) {
    let Ok(entries) = std::fs::read_dir(CURRICULUM_DIR) else { return };
    let mut paths: Vec<_> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        // The folder's package.json is the test runner's, not a catalog.
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .filter(|path| path.file_name().is_some_and(|name| name != "package.json"))
        .collect();
    paths.sort();
    for path in paths {
        let file = path.display().to_string();
        let catalog = std::fs::read_to_string(&path)
            .map_err(|error| error.to_string())
            .and_then(|text| serde_json::from_str::<SkillFile>(&text).map_err(|error| error.to_string()));
        match catalog {
            Ok(catalog) => match learning::upsert_skills(db, &catalog.skills).await {
                Ok(stored) => tracing::info!(file, stored, "skill catalog loaded"),
                Err(error) => tracing::error!(file, %error, "skill catalog not stored"),
            },
            Err(error) => tracing::error!(file, %error, "skill catalog not read"),
        }
    }
}

#[tokio::main]
async fn main() {
    // webauthn-rs writes the browser's answers and the credentials at debug
    // and trace, so it says no more than warnings, whatever RUST_LOG asks of
    // it: a directive for the same target replaces RUST_LOG's.
    let filter = ["webauthn_rs=warn", "webauthn_rs_core=warn"]
        .into_iter()
        .filter_map(|directive| directive.parse().ok())
        .fold(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
            tracing_subscriber::EnvFilter::add_directive,
        );
    tracing_subscriber::fmt().json().with_env_filter(filter).init();

    let command = std::env::args().nth(1).unwrap_or_else(|| "serve".to_string());
    if command == "version" || command == "--version" {
        println!("{}", aule_platform::version_line(&config::commit(&std::env::vars().collect())));
        return;
    }
    if !["serve", "worker", "migrate", "import-skills"].contains(&command.as_str()) {
        eprintln!("usage: aule-platform [serve|worker|migrate|import-skills <file>|version]");
        std::process::exit(2);
    }
    let config = Config::from_env().unwrap_or_else(|error| {
        eprintln!("aule-platform: {error}");
        std::process::exit(1);
    });
    // The platform's queries are short: compiling one with JIT costs more than
    // it saves, and a parallel plan only adds workers to wait for.
    let options = config
        .database_url
        .parse::<PgConnectOptions>()
        .unwrap_or_else(|error| fail("DATABASE_URL is not a Postgres address", error))
        .options([("jit", "off"), ("max_parallel_workers_per_gather", "0")]);
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect_with(options)
        .await
        .unwrap_or_else(|error| fail("the database could not be reached", error));
    aule_platform::migrate(&pool).await.unwrap_or_else(|error| fail("migrations failed", error));

    let state = AppState::new(pool, config);
    match command.as_str() {
        "migrate" => {}
        "import-skills" => {
            let path = std::env::args().nth(2).unwrap_or_else(|| fail("import-skills", "a file is needed"));
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|error| fail("the file could not be read", error));
            let catalog: SkillFile = serde_json::from_str(&text)
                .unwrap_or_else(|error| fail("the file is not a skill catalog", error));
            let stored = learning::upsert_skills(&state.db, &catalog.skills)
                .await
                .unwrap_or_else(|error| fail("the skills could not be stored", error));
            println!("{stored} skills stored from {path}");
        }
        "worker" => {
            tracing::info!(version = aule_platform::VERSION, commit = %state.config.commit, "worker started");
            tokio::select! {
                () = jobs::run_worker(state) => {}
                () = shutdown() => {}
            }
        }
        _ => {
            load_curriculum(&state.db).await;
            let addr = state.config.addr;
            let listener = tokio::net::TcpListener::bind(addr)
                .await
                .unwrap_or_else(|error| fail("the address could not be bound", error));
            tracing::info!(%addr, version = aule_platform::VERSION, commit = %state.config.commit, "platform listening");
            axum::serve(listener, http::router(state))
                .with_graceful_shutdown(shutdown())
                .await
                .unwrap_or_else(|error| fail("the server stopped", error));
        }
    }
}

fn fail(what: &str, error: impl std::fmt::Display) -> ! {
    eprintln!("aule-platform: {what}: {error}");
    std::process::exit(1);
}

async fn shutdown() {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("a SIGTERM handler can be installed");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}
