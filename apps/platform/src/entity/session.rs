//! A tutoring session, from its token to its review.

use sea_orm::entity::prelude::*;

#[sea_orm::model]
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "sessions")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub child_id: Option<Uuid>,
    pub audience: String,
    #[sea_orm(unique)]
    pub room: String,
    pub language: String,
    pub status: String,
    #[sea_orm(unique)]
    pub agent_token_hash: String,
    pub keep_transcript: bool,
    pub use_memory: bool,
    pub created_at: DateTimeUtc,
    pub started_at: Option<DateTimeUtc>,
    pub ended_at: Option<DateTimeUtc>,
    #[sea_orm(column_type = "Text")]
    pub end_reason: Option<String>,
    pub speaking_seconds: Option<i32>,
    pub reviewed_at: Option<DateTimeUtc>,
    pub device_id: Option<Uuid>,
    pub not_trying_streak: i32,
    pub stop_step: Option<String>,
    pub child_turns: Option<i32>,
    pub tutor_turns: Option<i32>,
    pub child_chars: Option<i32>,
    pub tutor_chars: Option<i32>,
    pub unchecked_exercises: i32,
    #[sea_orm(column_type = "JsonBinary")]
    pub agent_metrics: Option<Json>,
    pub breaks: i32,
    pub last_break_at: Option<DateTimeUtc>,
    pub pause_offered_at: Option<DateTimeUtc>,
    pub tired_at: Option<DateTimeUtc>,
    #[sea_orm(column_type = "JsonBinary")]
    pub objective: Option<Json>,
    /// Whether the session engine runs the session.
    pub engine: bool,
    #[sea_orm(column_type = "JsonBinary")]
    pub engine_start: Option<Json>,
}

impl ActiveModelBehavior for ActiveModel {}
