//! A family: the account. FHIR R4 `Group`, whose members are its children.

use sea_orm::entity::prelude::*;

#[sea_orm::model]
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "families")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTimeUtc,
    /// The link the family signed up from, when it came with one: a short code
    /// the team gives each place it shares the page (`signin::source_code`).
    #[sea_orm(column_type = "Text")]
    pub source: Option<String>,
}

impl ActiveModelBehavior for ActiveModel {}
