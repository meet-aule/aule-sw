//! A durable checkout, before the provider is called. No card data is stored.
use sea_orm::entity::prelude::*;

#[sea_orm::model]
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "billing_checkouts")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub family_id: Option<Uuid>,
    /// Null after cancellation. A normal unique constraint also works in schema sync.
    #[sea_orm(unique)]
    pub active_family_id: Option<Uuid>,
    pub kind: String,
    pub amount_cents: i64,
    pub quantity: i32,
    pub included_months: i32,
    pub activated_at: Option<DateTimeUtc>,
    pub currency: String,
    pub language: String,
    /// Adult contact and delivery details for a device; never a child's data.
    #[sea_orm(column_type = "JsonBinary")]
    pub buyer: Json,
    pub status: String,
    #[sea_orm(unique)]
    pub provider_id: Option<String>,
    pub checkout_url: Option<String>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    pub checked_at: Option<DateTimeUtc>,
    pub cancelled_at: Option<DateTimeUtc>,
    #[sea_orm(belongs_to, from = "family_id", to = "id", on_delete = "SetNull")]
    pub family: HasOne<super::family::Entity>,
}
impl ActiveModelBehavior for ActiveModel {}
