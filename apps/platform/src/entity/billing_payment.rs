//! Provider payment ids make repeated notifications harmless.
use sea_orm::entity::prelude::*;

#[sea_orm::model]
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "billing_payments")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub checkout_id: Uuid,
    /// The access period created for this payment, if it bought tutoring.
    pub access_id: Option<Uuid>,
    pub status: String,
    pub amount_cents: i64,
    pub currency: String,
    pub approved_at: Option<DateTimeUtc>,
    pub updated_at: DateTimeUtc,
    pub notified_status: Option<String>,
    pub merchant_notified_status: Option<String>,
    #[sea_orm(belongs_to, from = "checkout_id", to = "id", on_delete = "Cascade")]
    pub checkout: BelongsTo<super::billing_checkout::Entity>,
}
impl ActiveModelBehavior for ActiveModel {}
