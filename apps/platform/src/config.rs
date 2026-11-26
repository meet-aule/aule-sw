//! Settings, read from the environment once at start. Every problem is
//! reported together and the process does not start with one.

use std::collections::HashMap;
use std::net::SocketAddr;

use webauthn_rs::prelude::Url;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub addr: SocketAddr,
    /// Bearer token of the operator API. Stands in for family sign-in, which
    /// is not built yet.
    pub admin_token: String,
    pub livekit: Option<LiveKit>,
    pub agent_name: String,
    pub session_minutes: u32,
    /// Minutes of work after which a break is offered.
    pub break_every_minutes: u32,
    /// Hours a transcript is kept when the guardian agreed to keep it.
    pub transcript_hours: u32,
    /// What a session the engine runs may do with a photo of the homework, at
    /// most: 0 nothing, 1 the photo sets the homework's level. The agent says
    /// what it can do when it starts the session, and gets the lesser.
    pub engine_homework: u8,
    pub supervisor: Option<Supervisor>,
    pub embeddings: Option<Embeddings>,
    pub mail: Option<Mail>,
    pub events_webhook: Option<EventsWebhook>,
    /// Path of the Firebase service account key, for push notifications.
    pub fcm_service_account: Option<String>,
    /// The Google client that guardians' sign-ins must have been issued for.
    /// Without one, the emailed code is the only way in.
    pub google_client_id: Option<String>,
    /// The addresses of Aule's team: a session of theirs also reaches the
    /// team's routes, which the team's console calls, and only they get the
    /// console's codes (`signin::team_start`).
    pub admin_emails: Vec<String>,
    /// The team's console as a WebAuthn relying party: its passkeys are made
    /// for this RP id and accepted only from this origin (`passkeys`).
    pub admin_passkeys: AdminPasskeys,
    /// Temporarily allow free sessions without plan quotas or trial expiry.
    pub free_access: bool,
    /// GitHub's OAuth app, Meta's app and Apple's Services ID for sign-in.
    /// Each provider is offered only when all its settings are there.
    pub github: Option<OAuthApp>,
    pub meta: Option<OAuthApp>,
    pub apple: Option<AppleSignIn>,
    /// Minutes east of UTC that devices are told, for their clock.
    pub timezone_offset_minutes: i32,
    /// The commit the image was built from (see [`commit`]).
    pub commit: String,
}

#[derive(Clone, Debug)]
pub struct AdminPasskeys {
    /// What the passkeys are made for: the console's host, or a domain it is
    /// under. Changing it strands every passkey made before.
    pub rp_id: String,
    /// The one origin a ceremony is accepted from, like
    /// `https://admin.meetaule.com`: the console's own ADMIN_PUBLIC_URL, with
    /// no other subdomain or port.
    pub origin: String,
}

#[derive(Clone, Debug)]
pub struct OAuthApp {
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Clone, Debug)]
pub struct AppleSignIn {
    pub services_id: String,
    pub team_id: String,
    pub key_id: String,
    /// The `.p8` file Apple gave for Sign in with Apple.
    pub key_pem: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct Mail {
    /// For example `smtps://user:password@smtp.example.org:465`.
    pub smtp_url: String,
    pub from: String,
}

/// Where events are delivered outside the platform, signed with the secret.
#[derive(Clone, Debug)]
pub struct EventsWebhook {
    pub url: String,
    pub secret: String,
}

#[derive(Clone, Debug)]
pub struct LiveKit {
    /// URL the person's browser or device connects to.
    pub public_url: String,
    /// Where the platform calls LiveKit's server API to open a session's
    /// room: the agent's `LIVEKIT_URL`, as http:// or https://.
    pub service_url: String,
    pub api_key: String,
    pub api_secret: String,
}

#[derive(Clone, Debug)]
pub struct Supervisor {
    pub api_key: String,
    /// Plans and reviews: runs outside the conversation, so it can think.
    pub model: String,
    /// Guidance during a session: has to keep up with the conversation.
    pub live_model: String,
}

#[derive(Clone, Debug)]
pub struct Embeddings {
    /// Base URL of an OpenAI-compatible embeddings API, e.g. a local Ollama.
    pub url: String,
    pub model: String,
    pub api_key: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ConfigError(pub String);

pub const MIN_ADMIN_TOKEN_LENGTH: usize = 32;

/// The commit the image was built from: `AULE_COMMIT`, a build argument, when
/// it is a commit's hex digits, and "unknown" otherwise. Read on its own, so
/// that `aule-platform version` needs no other setting.
pub fn commit(env: &HashMap<String, String>) -> String {
    env.get("AULE_COMMIT")
        .map(|value| value.trim())
        .filter(|value| (7..=40).contains(&value.len()))
        .filter(|value| value.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
        .unwrap_or("unknown")
        .to_string()
}

/// The console's origin as a passkey's is checked: `https://<host>[:<port>]`,
/// or `http://localhost:<port>` to work locally, with no path. The console's
/// own ADMIN_PUBLIC_URL takes the same, and 127.0.0.1 besides, which is no
/// relying party: WebAuthn takes no IP address as an RP id.
fn passkey_origin(text: &str) -> Option<Url> {
    let port = |port: &str| (1..=5).contains(&port.len()) && port.bytes().all(|byte| byte.is_ascii_digit());
    let valid = if let Some(rest) = text.strip_prefix("https://") {
        let (host, at) = rest.split_once(':').map_or((rest, None), |(host, at)| (host, Some(at)));
        !host.is_empty()
            && host
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b".-".contains(&byte))
            && at.is_none_or(port)
    } else {
        text.strip_prefix("http://localhost:").is_some_and(port)
    };
    // A port past 65535 is still refused here.
    valid.then(|| Url::parse(text).ok()).flatten()
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_map(&std::env::vars().collect())
    }

    pub fn from_map(env: &HashMap<String, String>) -> Result<Self, ConfigError> {
        let get = |name: &str| env.get(name).map(|value| value.trim()).filter(|value| !value.is_empty());
        let mut problems: Vec<String> = Vec::new();

        let database_url = get("DATABASE_URL").unwrap_or_default().to_string();
        if !database_url.starts_with("postgres://") && !database_url.starts_with("postgresql://") {
            problems.push("DATABASE_URL must be a postgres:// URL".into());
        }

        let addr = get("AULE_PLATFORM_ADDR").unwrap_or("127.0.0.1:8091");
        let addr = addr.parse::<SocketAddr>().unwrap_or_else(|_| {
            problems.push("AULE_PLATFORM_ADDR must look like 127.0.0.1:8091".into());
            SocketAddr::from(([127, 0, 0, 1], 8091))
        });

        let admin_token = get("AULE_ADMIN_TOKEN").unwrap_or_default().to_string();
        if admin_token.len() < MIN_ADMIN_TOKEN_LENGTH {
            problems.push(format!("AULE_ADMIN_TOKEN must have at least {MIN_ADMIN_TOKEN_LENGTH} characters"));
        }

        let mut whole = |name: &str, default: u32, min: u32, max: u32| {
            let value = get(name).map_or(Some(default), |raw| raw.parse::<u32>().ok());
            match value {
                Some(value) if (min..=max).contains(&value) => value,
                _ => {
                    problems.push(format!("{name} must be a whole number from {min} to {max}"));
                    default
                }
            }
        };
        let session_minutes = whole("AULE_SESSION_MINUTES", 20, 1, 120);
        let break_every_minutes = whole("AULE_BREAK_EVERY_MINUTES", 30, 5, 120);
        let transcript_hours = whole("AULE_TRANSCRIPT_HOURS", 24, 1, 24);
        let engine_homework = whole("AULE_ENGINE_HOMEWORK", 0, 0, 1) as u8;
        let free_access = match get("AULE_FREE_ACCESS") {
            None | Some("0") => false,
            Some("1") => true,
            _ => {
                problems.push("AULE_FREE_ACCESS must be 1, 0 or left out".into());
                false
            }
        };

        let livekit = match (get("LIVEKIT_API_KEY"), get("LIVEKIT_API_SECRET")) {
            (Some(api_key), Some(api_secret)) => {
                let public_url = get("AULE_LIVEKIT_PUBLIC_URL").or(get("LIVEKIT_URL")).unwrap_or_default();
                if !public_url.starts_with("ws://") && !public_url.starts_with("wss://") {
                    problems.push(
                        "AULE_LIVEKIT_PUBLIC_URL (or LIVEKIT_URL) must be a ws:// or wss:// URL".into(),
                    );
                }
                // The same server, at the address the agent uses: ws:// is http:// to its API.
                // The platform hands LiveKit the agent's token there, so there is no falling
                // back to the public address, which may go through a proxy.
                let service_url = get("LIVEKIT_URL").unwrap_or_default().trim_end_matches('/');
                let service_url = match service_url.strip_prefix("ws") {
                    Some(rest) => format!("http{rest}"),
                    None => service_url.to_string(),
                };
                if !service_url.starts_with("http://") && !service_url.starts_with("https://") {
                    problems.push(
                        "LIVEKIT_URL, the address the agent connects to, must be set with the LiveKit keys, \
                         as a ws://, wss://, http:// or https:// URL"
                            .into(),
                    );
                }
                Some(LiveKit {
                    public_url: public_url.to_string(),
                    service_url,
                    api_key: api_key.to_string(),
                    api_secret: api_secret.to_string(),
                })
            }
            (None, None) => None,
            _ => {
                problems.push("LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set together".into());
                None
            }
        };

        let supervisor = get("ANTHROPIC_API_KEY").map(|api_key| Supervisor {
            api_key: api_key.to_string(),
            model: get("AULE_SUPERVISOR_MODEL").unwrap_or("claude-sonnet-5-5").to_string(),
            live_model: get("AULE_SUPERVISOR_LIVE_MODEL").unwrap_or("claude-haiku-5-5").to_string(),
        });

        let embeddings = get("AULE_EMBEDDINGS_URL").map(|url| Embeddings {
            url: url.trim_end_matches('/').to_string(),
            model: get("AULE_EMBEDDINGS_MODEL").unwrap_or("bge-m3").to_string(),
            api_key: get("AULE_EMBEDDINGS_API_KEY").map(str::to_string),
        });
        if let Some(embeddings) = &embeddings
            && !embeddings.url.starts_with("http://")
            && !embeddings.url.starts_with("https://")
        {
            problems.push("AULE_EMBEDDINGS_URL must be an http:// or https:// URL".into());
        }

        let mail = match (get("AULE_SMTP_URL"), get("AULE_MAIL_FROM")) {
            (Some(smtp_url), Some(from)) => {
                if !smtp_url.starts_with("smtp://") && !smtp_url.starts_with("smtps://") {
                    problems.push("AULE_SMTP_URL must be an smtp:// or smtps:// URL".into());
                }
                if !from.contains('@') {
                    problems.push("AULE_MAIL_FROM must be an email address".into());
                }
                Some(Mail { smtp_url: smtp_url.to_string(), from: from.to_string() })
            }
            (None, None) => None,
            _ => {
                problems.push("AULE_SMTP_URL and AULE_MAIL_FROM must be set together".into());
                None
            }
        };

        let events_webhook = match (get("AULE_EVENTS_WEBHOOK_URL"), get("AULE_EVENTS_WEBHOOK_SECRET")) {
            (Some(url), Some(secret)) => {
                if !url.starts_with("https://") && !url.starts_with("http://127.0.0.1") {
                    problems.push("AULE_EVENTS_WEBHOOK_URL must be https:// (or http://127.0.0.1)".into());
                }
                if secret.len() < 32 {
                    problems.push("AULE_EVENTS_WEBHOOK_SECRET must have at least 32 characters".into());
                }
                Some(EventsWebhook { url: url.to_string(), secret: secret.to_string() })
            }
            (None, None) => None,
            _ => {
                problems.push(
                    "AULE_EVENTS_WEBHOOK_URL and AULE_EVENTS_WEBHOOK_SECRET must be set together".into(),
                );
                None
            }
        };

        // Lima, where Aule is made, unless told otherwise.
        let timezone_offset_minutes = match get("AULE_TIMEZONE_OFFSET_MINUTES").map(str::parse::<i32>) {
            None => -300,
            Some(Ok(minutes)) if (-720..=840).contains(&minutes) => minutes,
            Some(_) => {
                problems.push("AULE_TIMEZONE_OFFSET_MINUTES must be a whole number from -720 to 840".into());
                -300
            }
        };

        let google_client_id = get("AULE_GOOGLE_CLIENT_ID").map(str::to_string);
        if google_client_id.as_deref().is_some_and(|id| !crate::google::is_client_id(id)) {
            problems.push("AULE_GOOGLE_CLIENT_ID must end in .apps.googleusercontent.com".into());
        }

        let admin_emails: Vec<String> = get("AULE_ADMIN_EMAILS")
            .unwrap_or_default()
            .split(',')
            .map(|email| email.trim().to_lowercase())
            .filter(|email| !email.is_empty())
            .collect();
        if admin_emails.iter().any(|email| crate::signin::normalized_email(email).is_err()) {
            problems.push("AULE_ADMIN_EMAILS must be email addresses separated by commas".into());
        }

        // The production console's, unless told otherwise, so the server's
        // settings need nothing new.
        let rp_id = get("AULE_ADMIN_PASSKEY_RP_ID").unwrap_or("admin.meetaule.com").to_string();
        let origin = get("AULE_ADMIN_PASSKEY_ORIGIN").unwrap_or("https://admin.meetaule.com");
        let origin = origin.trim_end_matches('/').to_string();
        match passkey_origin(&origin) {
            // The library's own rule: the origin's host, or a domain it is
            // under. An IP address has no domain, so it is never one.
            Some(url) if webauthn_rs::WebauthnBuilder::new(&rp_id, &url).is_err() => problems.push(
                "AULE_ADMIN_PASSKEY_RP_ID must be the host of AULE_ADMIN_PASSKEY_ORIGIN, or a domain it is under"
                    .into(),
            ),
            Some(_) => {}
            None => problems.push(
                "AULE_ADMIN_PASSKEY_ORIGIN must be the console's https:// origin, like \
                 https://admin.meetaule.com, or http://localhost:<port> to work locally"
                    .into(),
            ),
        }
        let admin_passkeys = AdminPasskeys { rp_id, origin };

        let mut app = |id: &str, secret: &str| match (get(id), get(secret)) {
            (Some(client_id), Some(client_secret)) => {
                Some(OAuthApp { client_id: client_id.to_string(), client_secret: client_secret.to_string() })
            }
            (None, None) => None,
            _ => {
                problems.push(format!("{id} and {secret} must be set together"));
                None
            }
        };
        let github = app("AULE_GITHUB_CLIENT_ID", "AULE_GITHUB_CLIENT_SECRET");
        let meta = app("AULE_META_APP_ID", "AULE_META_APP_SECRET");

        const APPLE: [&str; 4] =
            ["AULE_APPLE_SERVICES_ID", "AULE_APPLE_TEAM_ID", "AULE_APPLE_KEY_ID", "AULE_APPLE_PRIVATE_KEY"];
        let apple = match APPLE.map(get) {
            [Some(services_id), Some(team_id), Some(key_id), Some(key)] => {
                if !crate::oauth::is_services_id(services_id) {
                    problems.push("AULE_APPLE_SERVICES_ID must look like com.example.signin".into());
                }
                if !crate::oauth::is_apple_id(team_id) || !crate::oauth::is_apple_id(key_id) {
                    problems.push(
                        "AULE_APPLE_TEAM_ID and AULE_APPLE_KEY_ID must be ten letters and digits".into(),
                    );
                }
                // The .p8 file in base64, so that it fits on one line.
                use base64::Engine as _;
                let key_pem = base64::engine::general_purpose::STANDARD.decode(key).unwrap_or_default();
                if jsonwebtoken::EncodingKey::from_ec_pem(&key_pem).is_err() {
                    problems.push("AULE_APPLE_PRIVATE_KEY must be the .p8 key file in base64".into());
                }
                Some(AppleSignIn {
                    services_id: services_id.to_string(),
                    team_id: team_id.to_string(),
                    key_id: key_id.to_string(),
                    key_pem,
                })
            }
            [None, None, None, None] => None,
            _ => {
                problems.push(format!("{} must be set together", APPLE.join(", ")));
                None
            }
        };

        if !problems.is_empty() {
            return Err(ConfigError(problems.join("; ")));
        }
        Ok(Self {
            database_url,
            addr,
            admin_token,
            livekit,
            agent_name: get("AULE_AGENT_NAME").unwrap_or("aule-tutor").to_string(),
            session_minutes,
            break_every_minutes,
            transcript_hours,
            engine_homework,
            supervisor,
            embeddings,
            mail,
            events_webhook,
            fcm_service_account: get("AULE_FCM_SERVICE_ACCOUNT").map(str::to_string),
            google_client_id,
            admin_emails,
            admin_passkeys,
            free_access,
            github,
            meta,
            apple,
            timezone_offset_minutes,
            commit: commit(env),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn complete() -> HashMap<String, String> {
        [
            ("DATABASE_URL", "postgres://aule@localhost/aule"),
            ("AULE_ADMIN_TOKEN", "0123456789abcdef0123456789abcdef"),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect()
    }

    #[test]
    fn the_minimum_is_a_database_and_an_admin_token() {
        let config = Config::from_map(&complete()).unwrap();

        assert_eq!(config.addr.to_string(), "127.0.0.1:8091");
        assert_eq!(config.agent_name, "aule-tutor");
        assert_eq!((config.session_minutes, config.transcript_hours), (20, 24));
        assert!(config.livekit.is_none() && config.supervisor.is_none() && config.embeddings.is_none());
        assert!(config.mail.is_none() && config.events_webhook.is_none());
        assert!(config.github.is_none() && config.meta.is_none() && config.apple.is_none());
        assert!(config.admin_emails.is_empty());
        assert!(!config.free_access);
        assert_eq!(config.engine_homework, 0);

        let mut env = complete();
        env.insert("AULE_FREE_ACCESS".into(), "1".into());
        assert!(Config::from_map(&env).unwrap().free_access);
        env.insert("AULE_FREE_ACCESS".into(), "yes".into());
        assert!(Config::from_map(&env).unwrap_err().to_string().contains("AULE_FREE_ACCESS"));
        env.insert("AULE_FREE_ACCESS".into(), "0".into());
        assert!(!Config::from_map(&env).unwrap().free_access);
        env.insert("AULE_ADMIN_EMAILS".into(), " Admin@Example.org, gonzalo@example.org ,".into());
        assert_eq!(
            Config::from_map(&env).unwrap().admin_emails,
            ["admin@example.org", "gonzalo@example.org"]
        );
        env.insert("AULE_ADMIN_EMAILS".into(), "admin@example.org; nobody".into());
        assert!(Config::from_map(&env).unwrap_err().to_string().contains("AULE_ADMIN_EMAILS"));
        assert_eq!(config.timezone_offset_minutes, -300);
    }

    #[test]
    fn the_engine_reads_a_photo_of_the_homework_only_when_told_to() {
        let mut env = complete();
        env.insert("AULE_ENGINE_HOMEWORK".into(), "1".into());
        assert_eq!(Config::from_map(&env).unwrap().engine_homework, 1);
        env.insert("AULE_ENGINE_HOMEWORK".into(), "0".into());
        assert_eq!(Config::from_map(&env).unwrap().engine_homework, 0);
        // Working through the homework itself is not there yet.
        for odd in ["2", "-1", "yes"] {
            env.insert("AULE_ENGINE_HOMEWORK".into(), odd.into());
            let message = Config::from_map(&env).unwrap_err().to_string();
            assert!(
                message.contains("AULE_ENGINE_HOMEWORK must be a whole number from 0 to 1"),
                "{odd}: {message}"
            );
        }
    }

    #[test]
    fn the_commit_is_the_one_the_image_was_given_or_unknown() {
        let mut env = complete();
        assert_eq!(Config::from_map(&env).unwrap().commit, "unknown");
        env.insert("AULE_COMMIT".into(), " 0123456789ab ".into());
        assert_eq!(Config::from_map(&env).unwrap().commit, "0123456789ab");
        env.insert("AULE_COMMIT".into(), "a".repeat(40));
        assert_eq!(commit(&env), "a".repeat(40));
        // It is shown as it is, so anything that is not a commit is not taken.
        for odd in ["", "abc12", "0123456789AB", "\"><script>", "0123456789ab-dirty", &"a".repeat(41)] {
            env.insert("AULE_COMMIT".into(), odd.into());
            assert_eq!(Config::from_map(&env).unwrap().commit, "unknown", "{odd}");
        }
        assert_eq!(
            crate::version_line("0123456789ab"),
            format!("aule-platform {} (0123456789ab)", crate::VERSION)
        );
    }

    #[test]
    fn the_consoles_passkeys_are_for_its_own_origin() {
        let passkeys =
            |env: &HashMap<String, String>| Config::from_map(env).map(|config| config.admin_passkeys);
        // Production's, unless told otherwise.
        let default = passkeys(&complete()).unwrap();
        assert_eq!(
            (default.rp_id.as_str(), default.origin.as_str()),
            ("admin.meetaule.com", "https://admin.meetaule.com")
        );

        let mut env = complete();
        let mut set = |rp_id: &str, origin: &str| {
            env.insert("AULE_ADMIN_PASSKEY_RP_ID".into(), rp_id.into());
            env.insert("AULE_ADMIN_PASSKEY_ORIGIN".into(), origin.into());
            passkeys(&env)
        };
        // To work locally; and a domain the console's host is under.
        let local = set("localhost", "http://localhost:8092/").unwrap();
        assert_eq!((local.rp_id.as_str(), local.origin.as_str()), ("localhost", "http://localhost:8092"));
        assert!(set("meetaule.com", "https://admin.meetaule.com").is_ok());
        assert!(set("admin.example.org", "https://admin.example.org:8443").is_ok());

        for (rp_id, origin, setting) in [
            // An RP id that is not the origin's host, nor a domain it is under.
            ("admin.meetaule.com", "https://playground.meetaule.com", "AULE_ADMIN_PASSKEY_RP_ID must be"),
            ("eetaule.com", "https://admin.meetaule.com", "AULE_ADMIN_PASSKEY_RP_ID must be"),
            ("evil.example", "https://admin.meetaule.com", "AULE_ADMIN_PASSKEY_RP_ID must be"),
            ("Admin.MeetAule.com", "https://admin.meetaule.com", "AULE_ADMIN_PASSKEY_RP_ID must be"),
            // No IP address is an RP id.
            ("127.0.0.1", "https://127.0.0.1", "AULE_ADMIN_PASSKEY_RP_ID must be"),
            ("127.0.0.1", "http://127.0.0.1:8092", "AULE_ADMIN_PASSKEY_ORIGIN must be"),
            // http:// only to this machine, and only with its port.
            ("admin.meetaule.com", "http://admin.meetaule.com", "AULE_ADMIN_PASSKEY_ORIGIN must be"),
            ("localhost", "http://localhost", "AULE_ADMIN_PASSKEY_ORIGIN must be"),
            // An origin, not a page: no path, query or user.
            ("admin.meetaule.com", "https://admin.meetaule.com/panel", "AULE_ADMIN_PASSKEY_ORIGIN must be"),
            ("admin.meetaule.com", "https://admin.meetaule.com?x=1", "AULE_ADMIN_PASSKEY_ORIGIN must be"),
            ("admin.meetaule.com", "https://ana@admin.meetaule.com", "AULE_ADMIN_PASSKEY_ORIGIN must be"),
            ("admin.meetaule.com", "https://admin.meetaule.com:99999", "AULE_ADMIN_PASSKEY_ORIGIN must be"),
            ("admin.meetaule.com", "https://admin.meetaule.com:", "AULE_ADMIN_PASSKEY_ORIGIN must be"),
            ("admin.meetaule.com", "admin.meetaule.com", "AULE_ADMIN_PASSKEY_ORIGIN must be"),
        ] {
            let message = set(rp_id, origin).unwrap_err().to_string();
            assert!(message.contains(setting), "{rp_id} {origin}: {message}");
        }
    }

    #[test]
    fn a_sign_in_provider_needs_all_its_settings() {
        let mut env = complete();
        env.insert("AULE_GITHUB_CLIENT_ID".into(), "Ov23liExample".into());
        env.insert("AULE_APPLE_SERVICES_ID".into(), "com.example.signin".into());
        let message = Config::from_map(&env).unwrap_err().to_string();
        assert!(message.contains("AULE_GITHUB_CLIENT_ID and AULE_GITHUB_CLIENT_SECRET"), "{message}");
        assert!(message.contains("AULE_APPLE_PRIVATE_KEY must be set together"), "{message}");

        env.insert("AULE_GITHUB_CLIENT_SECRET".into(), "secret".into());
        env.insert("AULE_APPLE_TEAM_ID".into(), "TEAM123456".into());
        env.insert("AULE_APPLE_KEY_ID".into(), "KEY1234567".into());
        env.insert("AULE_APPLE_PRIVATE_KEY".into(), "bm90IGEga2V5".into());
        let message = Config::from_map(&env).unwrap_err().to_string();
        assert!(message.contains("AULE_APPLE_PRIVATE_KEY must be the .p8 key file"), "{message}");

        env.remove("AULE_APPLE_SERVICES_ID");
        env.remove("AULE_APPLE_TEAM_ID");
        env.remove("AULE_APPLE_KEY_ID");
        env.remove("AULE_APPLE_PRIVATE_KEY");
        let config = Config::from_map(&env).unwrap();
        assert_eq!(config.github.unwrap().client_id, "Ov23liExample");
        assert!(config.apple.is_none());
    }

    #[test]
    fn every_problem_is_reported_at_once() {
        let env = [
            ("AULE_ADMIN_TOKEN", "short"),
            ("LIVEKIT_API_KEY", "key"),
            ("AULE_TRANSCRIPT_HOURS", "72"),
            ("AULE_SMTP_URL", "smtps://mail.example.org"),
            ("AULE_EVENTS_WEBHOOK_URL", "http://example.org/hook"),
            ("AULE_EVENTS_WEBHOOK_SECRET", "short"),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();

        let message = Config::from_map(&env).unwrap_err().to_string();

        for expected in [
            "DATABASE_URL",
            "AULE_ADMIN_TOKEN must have at least 32",
            "must be set together",
            "AULE_TRANSCRIPT_HOURS must be a whole number from 1 to 24",
            "AULE_SMTP_URL and AULE_MAIL_FROM must be set together",
            "AULE_EVENTS_WEBHOOK_URL must be https://",
            "AULE_EVENTS_WEBHOOK_SECRET must have at least 32",
        ] {
            assert!(message.contains(expected), "{expected} not in {message}");
        }
    }

    #[test]
    fn optional_parts_turn_on_with_their_settings() {
        let mut env = complete();
        for (name, value) in [
            ("LIVEKIT_URL", "ws://127.0.0.1:7880"),
            ("AULE_LIVEKIT_PUBLIC_URL", "wss://live.example.org"),
            ("LIVEKIT_API_KEY", "key"),
            ("LIVEKIT_API_SECRET", "secret"),
            ("ANTHROPIC_API_KEY", "sk-test"),
            ("AULE_EMBEDDINGS_URL", "http://127.0.0.1:11434/v1/"),
        ] {
            env.insert(name.to_string(), value.to_string());
        }

        let config = Config::from_map(&env).unwrap();

        let livekit = config.livekit.unwrap();
        assert_eq!(livekit.public_url, "wss://live.example.org");
        // Rooms are opened where the agent connects, not through the public address.
        assert_eq!(livekit.service_url, "http://127.0.0.1:7880");
        assert_eq!(config.supervisor.unwrap().live_model, "claude-haiku-5-5");
        let embeddings = config.embeddings.unwrap();
        assert_eq!(
            (embeddings.url.as_str(), embeddings.model.as_str()),
            ("http://127.0.0.1:11434/v1", "bge-m3")
        );
    }

    #[test]
    fn livekit_s_server_api_is_where_the_agent_connects() {
        let mut env = complete();
        env.insert("LIVEKIT_API_KEY".into(), "key".into());
        env.insert("LIVEKIT_API_SECRET".into(), "secret".into());
        let service_url =
            |env: &HashMap<String, String>| Config::from_map(env).unwrap().livekit.unwrap().service_url;

        // With one address for everyone, the API is that address.
        env.insert("LIVEKIT_URL".into(), "wss://live.example.org/".into());
        assert_eq!(service_url(&env), "https://live.example.org");
        env.insert("AULE_LIVEKIT_PUBLIC_URL".into(), "wss://live.example.org".into());
        env.insert("LIVEKIT_URL".into(), "http://127.0.0.1:7880".into());
        assert_eq!(service_url(&env), "http://127.0.0.1:7880");

        // The public address is never used instead: the agent's token is sent there.
        let refused = |env: &HashMap<String, String>| Config::from_map(env).unwrap_err().to_string();
        let expected = "LIVEKIT_URL, the address the agent connects to, must be set with the LiveKit keys";
        env.remove("LIVEKIT_URL");
        let message = refused(&env);
        assert!(message.contains(expected), "{message}");
        env.insert("LIVEKIT_URL".into(), "livekit:7880".into());
        let message = refused(&env);
        assert!(message.contains(expected), "{message}");
    }
}
