//! What the family is told after a session, and what comes next.

use sea_orm::entity::prelude::*;

#[sea_orm::model]
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "session_reviews")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub session_id: Uuid,
    pub child_id: Option<Uuid>,
    pub guardian_summary: String,
    pub next_step: Option<String>,
    pub flags: Vec<String>,
    /// The plan for the child's next session, written ahead; see `ahead`.
    #[sea_orm(column_type = "JsonBinary")]
    pub next_brief: Option<Json>,
    pub created_at: DateTimeUtc,
    #[sea_orm(belongs_to, from = "session_id", to = "id", on_delete = "Cascade")]
    pub session: BelongsTo<super::session::Entity>,
}

impl ActiveModelBehavior for ActiveModel {}
