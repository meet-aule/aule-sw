//! The tables as SeaORM entities. Each one lists the columns the code reads and
//! writes. The entities are where a table or a column is added: the migration
//! that creates it is generated from them (`cargo run --example migration`), and
//! a test fails while an entity has something the migrations do not create.

pub mod attempt;
pub mod billing_checkout;
pub mod billing_payment;
pub mod child;
pub mod consent_record;
pub mod correction;
pub mod device;
pub mod device_claim;
pub mod family;
pub mod firmware;
pub mod guardian;
pub mod guardian_child;
pub mod guardian_session;
pub mod item_difficulty;
pub mod job;
pub mod login_code;
pub mod memory;
pub mod notice;
pub mod outbox;
pub mod push_token;
pub mod session;
pub mod session_brief;
pub mod session_engine_input;
pub mod session_exercise;
pub mod session_flag;
pub mod session_guidance;
pub mod session_model_usage;
pub mod session_review;
pub mod session_turn;
pub mod skill;
pub mod subscription;
pub mod team_passkey;

/// Every entity, in one schema: what the migrations must create.
pub fn schema() -> sea_orm::SchemaBuilder {
    sea_orm::Schema::new(sea_orm::DbBackend::Postgres)
        .builder()
        .register(family::Entity)
        .register(guardian::Entity)
        .register(child::Entity)
        .register(guardian_child::Entity)
        .register(skill::Entity)
        .register(item_difficulty::Entity)
        .register(attempt::Entity)
        .register(correction::Entity)
        .register(consent_record::Entity)
        .register(session::Entity)
        .register(session_turn::Entity)
        .register(session_brief::Entity)
        .register(session_guidance::Entity)
        .register(session_review::Entity)
        .register(session_flag::Entity)
        .register(session_exercise::Entity)
        .register(memory::Entity)
        .register(outbox::Entity)
        .register(job::Entity)
        .register(device::Entity)
        .register(device_claim::Entity)
        .register(firmware::Entity)
        .register(login_code::Entity)
        .register(guardian_session::Entity)
        .register(notice::Entity)
        .register(push_token::Entity)
        .register(session_model_usage::Entity)
        .register(session_engine_input::Entity)
        .register(subscription::Entity)
        .register(billing_checkout::Entity)
        .register(billing_payment::Entity)
        .register(team_passkey::Entity)
}
