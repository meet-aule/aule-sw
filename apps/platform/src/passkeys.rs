//! Passkeys for the team's console (`apps/admin`). The platform is the
//! relying party: it checks every ceremony with webauthn-rs and keeps only
//! what is public (`team_passkeys`); the console carries the messages between
//! the browser and here.

use std::time::Duration;

use webauthn_rs::prelude::{Url, WebauthnError};
use webauthn_rs::{Webauthn, WebauthnBuilder};

use crate::config::AdminPasskeys;

/// How long the browser is given for a ceremony. The library only passes it
/// on; the platform keeps a ceremony a little longer and then drops it.
pub const CEREMONY_TIMEOUT: Duration = Duration::from_secs(240);

/// The team's console as a relying party: passkeys made for its RP id, and
/// ceremonies accepted only from its exact origin, with no other subdomain
/// or port (the library's defaults, left as they are).
pub fn relying_party(settings: &AdminPasskeys) -> Result<Webauthn, WebauthnError> {
    let origin = Url::parse(&settings.origin).map_err(|_| WebauthnError::Configuration)?;
    WebauthnBuilder::new(&settings.rp_id, &origin)?.rp_name("Aule").timeout(CEREMONY_TIMEOUT).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_relying_party_is_the_consoles_origin_and_nothing_else() {
        let settings =
            |rp_id: &str, origin: &str| AdminPasskeys { rp_id: rp_id.into(), origin: origin.into() };
        let rp = relying_party(&settings("admin.meetaule.com", "https://admin.meetaule.com")).unwrap();
        let allowed: Vec<&str> = rp.get_allowed_origins().iter().map(Url::as_str).collect();
        assert_eq!(allowed, ["https://admin.meetaule.com/"]);
        assert!(relying_party(&settings("localhost", "http://localhost:8092")).is_ok());
        for (rp_id, origin) in [
            ("admin.meetaule.com", "https://playground.meetaule.com"),
            ("evil.example", "https://admin.meetaule.com"),
            ("127.0.0.1", "https://127.0.0.1"),
            ("admin.meetaule.com", "not a url"),
        ] {
            assert!(relying_party(&settings(rp_id, origin)).is_err(), "{rp_id} {origin}");
        }
    }
}
