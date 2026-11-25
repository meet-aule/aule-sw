//! A passkey a team member signs in to the team's console with: its public
//! key, counter and flags as webauthn-rs keeps them, and never a secret.

use sea_orm::entity::prelude::*;

#[sea_orm::model]
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "team_passkeys")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    /// The team member's guardian account.
    pub guardian_id: Uuid,
    /// The raw credential id: a sign-in finds its passkey by it.
    #[sea_orm(unique)]
    pub credential_id: Vec<u8>,
    /// The WebAuthn user handle the authenticator keeps: random, the same for
    /// all of a member's passkeys, and never the guardian's id.
    pub user_handle: Uuid,
    /// webauthn-rs's `Passkey` as it serializes: the credential id, the public
    /// key, the counter, the transports and the flags.
    #[sea_orm(column_type = "JsonBinary")]
    pub passkey: Json,
    /// The member's name for it.
    pub label: String,
    pub created_at: DateTimeUtc,
    pub last_used_at: Option<DateTimeUtc>,
    #[sea_orm(belongs_to, from = "guardian_id", to = "id", on_delete = "Cascade")]
    pub guardian: BelongsTo<super::guardian::Entity>,
}

impl ActiveModelBehavior for ActiveModel {}
