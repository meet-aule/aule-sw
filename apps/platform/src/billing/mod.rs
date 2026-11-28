//! Durable billing, independent of the redirect the browser comes back with.
pub mod gateway;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use chrono::{Duration, Months, Utc};
use hmac::{Hmac, KeyInit, Mac};
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder,
    QuerySelect, Statement, TransactionTrait,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Sha256;
use std::collections::HashMap;
use uuid::Uuid;

use crate::auth::{Guardian, Input, Staff, same_token};
use crate::config::Payments;
use crate::entity::{
    billing_checkout as checkout, billing_payment as payment, family, guardian, subscription,
};
use crate::error::{ApiError, ApiResult};
use crate::plans::{CURRENCY, PRICE_CENTS};
use crate::state::AppState;
use gateway::{Agreement, Gateway, Payment, cents, reference, safe_checkout, valid_id};

pub const RECONCILE: &str = "reconcile_payment";
pub const RECEIPT: &str = "payment_receipt";
pub const ORDER_NOTICE: &str = "paid_order_notice";

fn configured(state: &AppState) -> ApiResult<(&Payments, &dyn Gateway)> {
    match (&state.config.payments, &state.payments) {
        (Some(settings), Some(gateway)) => Ok((settings, gateway.as_ref())),
        _ => Err(ApiError::Unavailable("payments are not configured")),
    }
}
fn provider(_: gateway::GatewayError) -> ApiError {
    ApiError::Unavailable("payment provider unavailable; please try again")
}
fn order_id(value: &str) -> Option<Uuid> {
    value.strip_prefix("aule:")?.parse().ok()
}
fn language(value: &str) -> &str {
    if value == "en" { "en" } else { "es" }
}
fn check_agreement(settings: &Payments, row: &checkout::Model, value: &Agreement) -> ApiResult<()> {
    if row.kind != "plan"
        || !valid_id(&value.id)
        || value.external_reference != reference(row.id)
        || value.collector_id != settings.collector_id
        || cents(value.auto_recurring.transaction_amount) != Some(row.amount_cents)
        || value.auto_recurring.currency_id != row.currency
        || value.auto_recurring.frequency != 1
        || value.auto_recurring.frequency_type != "months"
        || !["pending", "authorized", "paused", "cancelled"].contains(&value.status.as_str())
        || row.provider_id.as_ref().is_some_and(|id| id != &value.id)
    {
        return Err(ApiError::Unavailable("subscription verification failed"));
    }
    Ok(())
}
async fn save_agreement(
    state: &AppState,
    row: checkout::Model,
    value: Agreement,
) -> ApiResult<checkout::Model> {
    let (settings, _) = configured(state)?;
    check_agreement(settings, &row, &value)?;
    let txn = state.db.begin().await?;
    let row = checkout::Entity::find_by_id(row.id)
        .lock_exclusive()
        .one(&txn)
        .await?
        .ok_or(ApiError::NotFound("checkout"))?;
    if row.cancelled_at.is_some() && value.status != "cancelled" {
        return Ok(row);
    }
    let mut model = row.into_active_model();
    model.provider_id = Set(Some(value.id));
    model.status = Set(value.status.clone());
    model.checkout_url = Set(value.init_point.filter(|url| safe_checkout(url)));
    model.updated_at = Set(Utc::now());
    model.checked_at = Set(Some(Utc::now()));
    if value.status == "cancelled" {
        model.cancelled_at = Set(Some(Utc::now()));
        model.active_family_id = Set(None);
    }
    use sea_orm::ActiveModelTrait;
    let updated = model.update(&txn).await?;
    txn.commit().await?;
    Ok(updated)
}
fn public_checkout(row: &checkout::Model) -> Value {
    json!({ "id": row.id, "kind": row.kind, "status": row.status, "amount_cents": row.amount_cents, "currency": row.currency,
        "checkout_url": if row.status == "pending" { row.checkout_url.as_deref() } else { None }, "cancelled_at": row.cancelled_at })
}

pub async fn mine(guardian: Guardian, State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let adult =
        guardian::Entity::find_by_id(guardian.id).one(&state.db).await?.ok_or(ApiError::Unauthorized)?;
    let devices = checkout::Entity::find()
        .filter(checkout::Column::Kind.eq("device"))
        .filter(sea_orm::sea_query::Expr::cust_with_values(
            "lower(buyer->>'email') = $1",
            [adult.email.to_lowercase()],
        ))
        .filter(checkout::Column::Status.eq("approved"))
        .order_by_desc(checkout::Column::CreatedAt)
        .limit(20)
        .all(&state.db)
        .await?;
    let rows = checkout::Entity::find()
        .filter(checkout::Column::FamilyId.eq(guardian.family_id))
        .filter(checkout::Column::Kind.eq("plan"))
        .order_by_desc(checkout::Column::CreatedAt)
        .limit(10)
        .all(&state.db)
        .await?;
    let ids: Vec<Uuid> = rows.iter().map(|row| row.id).collect();
    let payments = if ids.is_empty() {
        vec![]
    } else {
        payment::Entity::find()
            .filter(payment::Column::CheckoutId.is_in(ids))
            .order_by_desc(payment::Column::UpdatedAt)
            .limit(20)
            .all(&state.db)
            .await?
    };
    Ok(Json(
        json!({ "available": configured(&state).is_ok(), "free_access": state.config.free_access, "price_cents": PRICE_CENTS, "currency": CURRENCY,
        "included_until": included_until(&state, guardian.family_id).await?, "subscription": rows.first().map(public_checkout), "devices": devices.iter().map(|o| json!({"id":o.id,"included_months":o.included_months,"activated_at":o.activated_at})).collect::<Vec<_>>(), "payments": payments.iter().map(|p| json!({ "id": p.id, "status": p.status, "amount_cents": p.amount_cents, "currency": p.currency, "approved_at": p.approved_at })).collect::<Vec<_>>() }),
    ))
}

#[derive(Deserialize)]
pub struct Subscribe {
    pub accept_recurring: bool,
    #[serde(default)]
    pub language: String,
}
pub async fn subscribe(
    guardian: Guardian,
    State(state): State<AppState>,
    Input(body): Input<Subscribe>,
) -> ApiResult<Json<Value>> {
    let (_, gateway) = configured(&state)?;
    if !body.accept_recurring {
        return Err(ApiError::bad_request("monthly renewal must be accepted"));
    }
    if state.config.free_access {
        return Err(ApiError::Conflict("free access is currently enabled"));
    }
    let _billing_lock = family_lock(&state, guardian.family_id).await?;
    if included_until(&state, guardian.family_id).await?.is_some() {
        return Err(ApiError::Conflict("included tutoring months are still active"));
    }
    let adult =
        guardian::Entity::find_by_id(guardian.id).one(&state.db).await?.ok_or(ApiError::Unauthorized)?;
    // One in-flight checkout per family, even across platform processes.
    let txn = state.db.begin().await?;
    family::Entity::find_by_id(guardian.family_id)
        .lock_exclusive()
        .one(&txn)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    let existing = checkout::Entity::find()
        .filter(checkout::Column::FamilyId.eq(guardian.family_id))
        .filter(checkout::Column::Kind.eq("plan"))
        .filter(checkout::Column::CancelledAt.is_null())
        .order_by_desc(checkout::Column::CreatedAt)
        .one(&txn)
        .await?;
    let (row, fresh) = if let Some(row) = existing {
        (row, false)
    } else {
        let now = Utc::now();
        let row = checkout::ActiveModel {
            id: Set(Uuid::new_v4()),
            family_id: Set(Some(guardian.family_id)),
            active_family_id: Set(Some(guardian.family_id)),
            kind: Set("plan".into()),
            included_months: Set(0),
            activated_at: Set(None),
            amount_cents: Set(PRICE_CENTS),
            quantity: Set(1),
            currency: Set(CURRENCY.into()),
            language: Set(language(&body.language).into()),
            buyer: Set(
                json!({ "email": adult.email, "recurring_consent": true, "accepted_at": now, "monthly_cents": PRICE_CENTS }),
            ),
            status: Set("creating".into()),
            provider_id: Set(None),
            checkout_url: Set(None),
            created_at: Set(now),
            updated_at: Set(now),
            checked_at: Set(None),
            cancelled_at: Set(None),
        };
        use sea_orm::ActiveModelTrait;
        (row.insert(&txn).await?, true)
    };
    txn.commit().await?;
    if !fresh && row.provider_id.is_some() {
        return Ok(Json(public_checkout(&row)));
    }
    // A timeout may mean the provider created it. Never issue a second create
    // for this reference: recover it through search, or leave it for support.
    let value = if fresh {
        gateway.create_agreement(row.id, &adult.email).await.map_err(provider)?
    } else {
        gateway
            .find_agreement(row.id)
            .await
            .map_err(provider)?
            .ok_or(ApiError::Unavailable("checkout is being confirmed; try again shortly"))?
    };
    let row = save_agreement(&state, row, value).await?;
    Ok(Json(public_checkout(&row)))
}

pub async fn cancel_family(state: &AppState, family_id: Uuid) -> ApiResult<()> {
    let rows = checkout::Entity::find()
        .filter(checkout::Column::FamilyId.eq(family_id))
        .filter(checkout::Column::Kind.eq("plan"))
        .filter(checkout::Column::CancelledAt.is_null())
        .all(&state.db)
        .await?;
    if rows.is_empty() {
        return Ok(());
    }
    let (_, gateway) = configured(state)?;
    for row in rows {
        let row = if row.provider_id.is_none() {
            let found =
                gateway.find_agreement(row.id).await.map_err(provider)?.ok_or(ApiError::Unavailable(
                    "the pending checkout must be reconciled before cancelling",
                ))?;
            save_agreement(state, row, found).await?
        } else {
            row
        };
        let id =
            row.provider_id.as_deref().ok_or(ApiError::Unavailable("subscription has no provider id"))?;
        let cancelled = gateway.cancel(id).await.map_err(provider)?;
        if cancelled.status != "cancelled" {
            return Err(ApiError::Unavailable("cancellation was not confirmed"));
        }
        save_agreement(state, row, cancelled).await?;
    }
    // Access rows are left alone: cancelling renewal keeps the month paid for.
    Ok(())
}
pub async fn cancel(guardian: Guardian, State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let _billing_lock = family_lock(&state, guardian.family_id).await?;
    cancel_family(&state, guardian.family_id).await?;
    mine(guardian, State(state)).await
}
pub async fn refresh(guardian: Guardian, State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rows = checkout::Entity::find()
        .filter(checkout::Column::FamilyId.eq(guardian.family_id))
        .filter(checkout::Column::Kind.eq("plan"))
        .order_by_desc(checkout::Column::CreatedAt)
        .limit(2)
        .all(&state.db)
        .await?;
    for row in rows {
        if row.checked_at.is_none_or(|t| t < Utc::now() - Duration::seconds(30)) {
            state.db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
                "with marked as (update billing_checkouts set checked_at = now() where id = $1 and (checked_at is null or checked_at < now() - interval '30 seconds') returning id) insert into jobs (kind,payload) select 'reconcile_payment', jsonb_build_object('type','checkout','id',id::text) from marked", [row.id.into()])).await?;
        }
    }
    mine(guardian, State(state)).await
}

/// Signatures identify the resource. Its actual amount and state are read
/// from the provider; nothing in the webhook's untrusted body grants access.
pub fn valid_signature(secret: &str, signature: &str, request_id: &str, data_id: &str, now: i64) -> bool {
    if secret.is_empty() || request_id.is_empty() || request_id.len() > 200 || !valid_id(data_id) {
        return false;
    }
    let parts: HashMap<_, _> = signature.split(',').filter_map(|v| v.trim().split_once('=')).collect();
    let Some(ts) = parts.get("ts") else {
        return false;
    };
    let Some(v1) = parts.get("v1").and_then(|v| hex::decode(v).ok()) else {
        return false;
    };
    let Some(timestamp) = ts.parse::<i64>().ok().filter(|t| *t > 0) else {
        return false;
    };
    let seconds = if timestamp > 10_000_000_000 { timestamp / 1000 } else { timestamp };
    if now.abs_diff(seconds) > 300 {
        return false;
    }
    let manifest = format!("id:{};request-id:{request_id};ts:{ts};", data_id.to_ascii_lowercase());
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(manifest.as_bytes());
    mac.verify_slice(&v1).is_ok()
}
#[derive(Deserialize)]
pub struct Webhook {
    #[serde(rename = "type")]
    pub kind: String,
    pub data: WebhookData,
}
#[derive(Deserialize)]
pub struct WebhookData {
    pub id: Value,
}
pub async fn webhook(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Input(body): Input<Webhook>,
) -> ApiResult<StatusCode> {
    let (settings, _) = configured(&state)?;
    let id = query.get("data.id").ok_or(ApiError::Unauthorized)?;
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or_default();
    if !valid_signature(
        &settings.webhook_secret,
        header("x-signature"),
        header("x-request-id"),
        id,
        Utc::now().timestamp(),
    ) {
        return Err(ApiError::Unauthorized);
    }
    let body_id =
        body.data.id.as_str().map(str::to_string).or_else(|| body.data.id.as_u64().map(|v| v.to_string()));
    if body_id.as_deref() != Some(id) {
        return Err(ApiError::bad_request("resource identifiers do not match"));
    }
    if ["payment", "subscription_preapproval", "subscription_authorized_payment"]
        .contains(&body.kind.as_str())
    {
        crate::jobs::enqueue(&state.db, RECONCILE, &json!({ "type": body.kind, "id": id })).await?;
    }
    Ok(StatusCode::OK)
}

/// A valid receipt gives one calendar month. Replaying it gives no more time.
pub async fn apply_payment(state: &AppState, row: &checkout::Model, value: Payment) -> ApiResult<()> {
    let (settings, _) = configured(state)?;
    if value.collector_id != settings.collector_id
        || value.live_mode != settings.live_mode
        || cents(value.transaction_amount) != Some(row.amount_cents)
        || value.currency_id != row.currency
        || value.external_reference.as_deref().is_some_and(|r| r != reference(row.id))
    {
        return Err(ApiError::Unavailable("payment verification failed"));
    }
    let approved = value.status == "approved"
        && cents(value.transaction_amount_refunded).is_some_and(|n| n < row.amount_cents);
    let revoked = ["refunded", "charged_back", "cancelled"].contains(&value.status.as_str())
        || cents(value.transaction_amount_refunded) == Some(row.amount_cents);
    let now = Utc::now();
    let period = if approved {
        let start = value.date_approved.ok_or(ApiError::Unavailable("payment approval date missing"))?;
        if start > now + Duration::minutes(5) {
            return Err(ApiError::Unavailable("payment approval date is in the future"));
        }
        Some((
            start,
            start
                .checked_add_months(Months::new(1))
                .ok_or(ApiError::Unavailable("invalid billing period"))?,
        ))
    } else {
        None
    };
    let txn = state.db.begin().await?;
    checkout::Entity::find_by_id(row.id)
        .lock_exclusive()
        .one(&txn)
        .await?
        .ok_or(ApiError::NotFound("checkout"))?;
    let old = payment::Entity::find_by_id(value.id.to_string()).one(&txn).await?;
    if old.as_ref().is_some_and(|p| p.checkout_id != row.id) {
        return Err(ApiError::Conflict("payment belongs to another checkout"));
    }
    // A provider's refund is terminal here, so an older in-flight approval
    // cannot resurrect the entitlement after a newer refund has been applied.
    if old.as_ref().is_some_and(|p| ["refunded", "charged_back", "cancelled"].contains(&p.status.as_str())) {
        return Ok(());
    }
    if old.as_ref().is_some_and(|p| p.status == "approved") && !approved && !revoked {
        return Ok(());
    }
    let access_id = old
        .as_ref()
        .and_then(|p| p.access_id)
        .or_else(|| (approved && row.kind == "plan").then(Uuid::new_v4));
    if row.kind == "plan"
        && let (Some(id), Some(family_id), Some((start, end))) = (access_id, row.family_id, period)
        && subscription::Entity::find_by_id(id).one(&txn).await?.is_none()
    {
        subscription::Entity::insert(subscription::ActiveModel {
            id: Set(id),
            family_id: Set(family_id),
            plan: Set("paid".into()),
            starts_at: Set(start),
            ends_at: Set(end),
            payment_token: Set(None),
            provider_subscription: Set(row.provider_id.clone()),
            cancelled_at: Set(None),
            granted_by: Set(None),
            note: Set(None),
            created_at: Set(now),
        })
        .exec(&txn)
        .await?;
    }
    if revoked && let Some(id) = access_id {
        subscription::Entity::delete_by_id(id).exec(&txn).await?;
    }
    let status = if revoked && value.status == "approved" { "refunded".to_string() } else { value.status };
    let changed = old.as_ref().is_none_or(|p| p.status != status);
    let model = payment::ActiveModel {
        id: Set(value.id.to_string()),
        checkout_id: Set(row.id),
        access_id: Set(access_id),
        status: Set(status.clone()),
        amount_cents: Set(row.amount_cents),
        currency: Set(row.currency.clone()),
        approved_at: Set(value.date_approved),
        updated_at: Set(now),
        notified_status: Set(old.as_ref().and_then(|p| p.notified_status.clone())),
        merchant_notified_status: Set(old.as_ref().and_then(|p| p.merchant_notified_status.clone())),
    };
    use sea_orm::ActiveModelTrait;
    if old.is_some() {
        model.update(&txn).await?;
    } else {
        model.insert(&txn).await?;
    }
    if row.kind == "device" {
        // One successful payment wins over a later rejected retry.
        let has_approved = payment::Entity::find()
            .filter(payment::Column::CheckoutId.eq(row.id))
            .filter(payment::Column::Status.eq("approved"))
            .one(&txn)
            .await?
            .is_some();
        let mut update = row.clone().into_active_model();
        update.status = Set(if has_approved { "approved".into() } else { status.clone() });
        update.updated_at = Set(now);
        update.update(&txn).await?;
    }
    if changed && ["approved", "rejected", "refunded", "charged_back"].contains(&status.as_str()) {
        crate::jobs::enqueue(&txn, RECEIPT, &json!({ "payment_id": value.id.to_string() })).await?;
        if row.kind == "device" {
            crate::jobs::enqueue(&txn, ORDER_NOTICE, &json!({ "payment_id": value.id.to_string() })).await?;
        }
    }
    txn.commit().await?;
    Ok(())
}

pub async fn reconcile_checkout(state: &AppState, id: Uuid) -> ApiResult<()> {
    let Some(mut row) = checkout::Entity::find_by_id(id).one(&state.db).await? else {
        return Ok(());
    };
    let (_, gateway) = configured(state)?;
    if row.kind == "plan" {
        let value = match row.provider_id.as_deref() {
            Some(id) => gateway.agreement(id).await.map_err(provider)?,
            None => match gateway.find_agreement(row.id).await.map_err(provider)? {
                Some(value) => value,
                None => return Ok(()),
            },
        };
        row = save_agreement(state, row, value).await?;
        let id = row.provider_id.as_deref().ok_or(ApiError::Unavailable("subscription has no id"))?;
        for invoice in gateway.invoices(id).await.map_err(provider)? {
            if invoice.preapproval_id != id {
                return Err(ApiError::Unavailable("invoice verification failed"));
            }
            if let Some(payment) = invoice.payment {
                apply_payment(state, &row, gateway.payment(&payment.id.to_string()).await.map_err(provider)?)
                    .await?;
            }
        }
    } else {
        for value in gateway.order_payments(row.id).await.map_err(provider)? {
            if value.external_reference.as_deref() != Some(reference(row.id).as_str()) {
                return Err(ApiError::Unavailable("order reference mismatch"));
            }
            apply_payment(state, &row, value).await?;
        }
    }
    use sea_orm::ActiveModelTrait;
    let mut update = checkout::ActiveModel { id: Set(row.id), ..Default::default() };
    update.checked_at = Set(Some(Utc::now()));
    update.update(&state.db).await?;
    Ok(())
}
pub async fn reconcile(state: &AppState, payload: &Value) -> ApiResult<()> {
    let (_, gateway) = configured(state)?;
    let kind = payload["type"].as_str().ok_or(ApiError::bad_request("missing event type"))?;
    let id = payload["id"].as_str().ok_or(ApiError::bad_request("missing event id"))?;
    match kind {
        "checkout" => {
            reconcile_checkout(state, id.parse().map_err(|_| ApiError::bad_request("invalid checkout id"))?)
                .await
        }
        "subscription_preapproval" => {
            let value = gateway.agreement(id).await.map_err(provider)?;
            let Some(key) = order_id(&value.external_reference) else {
                return Ok(());
            };
            let Some(row) = checkout::Entity::find_by_id(key).one(&state.db).await? else {
                return Ok(());
            };
            save_agreement(state, row, value).await?;
            reconcile_checkout(state, key).await
        }
        "subscription_authorized_payment" => {
            let invoice = gateway.invoice(id).await.map_err(provider)?;
            let row = checkout::Entity::find()
                .filter(checkout::Column::ProviderId.eq(&invoice.preapproval_id))
                .one(&state.db)
                .await?;
            if let (Some(row), Some(payment)) = (row, invoice.payment) {
                apply_payment(state, &row, gateway.payment(&payment.id.to_string()).await.map_err(provider)?)
                    .await?;
            }
            Ok(())
        }
        "payment" => {
            let value = gateway.payment(id).await.map_err(provider)?;
            let key = value.external_reference.as_deref().and_then(order_id);
            if let Some(key) = key
                && let Some(row) = checkout::Entity::find_by_id(key).one(&state.db).await?
            {
                apply_payment(state, &row, value).await?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Rotating oldest-first checks recover lost webhooks without flooding the API.
pub async fn schedule(state: &AppState) -> ApiResult<()> {
    if configured(state).is_err() {
        return Ok(());
    }
    state.db.execute_raw(Statement::from_string(DbBackend::Postgres,
        "with due as (select id from billing_checkouts where (checked_at is null or checked_at < now() - interval '15 minutes') and (kind = 'plan' or created_at > now() - interval '90 days') and (cancelled_at is null or cancelled_at > now() - interval '90 days') order by checked_at nulls first, created_at limit 20 for update skip locked), marked as (update billing_checkouts set checked_at = now() from due where billing_checkouts.id = due.id returning billing_checkouts.id) insert into jobs (kind, payload) select 'reconcile_payment', jsonb_build_object('type', 'checkout', 'id', id::text) from marked".to_string())).await?;
    Ok(())
}

pub async fn send_receipt(state: &AppState, id: &str) -> ApiResult<()> {
    let txn = state.db.begin().await?;
    let Some(row) = payment::Entity::find_by_id(id.to_string()).lock_exclusive().one(&txn).await? else {
        return Ok(());
    };
    if row.notified_status.as_deref() == Some(&row.status) {
        return Ok(());
    }
    let Some(order) = checkout::Entity::find_by_id(row.checkout_id).one(&state.db).await? else {
        return Ok(());
    };
    let Some(email) = order.buyer["email"].as_str() else {
        return Ok(());
    };
    let Some(mailer) = &state.mailer else {
        return Err(ApiError::Unavailable("payment receipt email is unavailable"));
    };
    let en = order.language == "en";
    let state_text = match row.status.as_str() {
        "approved" => {
            if en {
                "Payment confirmed"
            } else {
                "Pago confirmado"
            }
        }
        "rejected" => {
            if en {
                "Payment declined"
            } else {
                "Pago rechazado"
            }
        }
        "refunded" => {
            if en {
                "Payment refunded"
            } else {
                "Pago reembolsado"
            }
        }
        _ => {
            if en {
                "Payment updated"
            } else {
                "Pago actualizado"
            }
        }
    };
    let body = if en {
        format!(
            "{state_text}.\n\nAmount: S/ {:.2}.\nReference: {}.\n\nYou can review your payments and cancel monthly renewal in your Aule account.",
            row.amount_cents as f64 / 100.0,
            order.id
        )
    } else {
        format!(
            "{state_text}.\n\nImporte: S/ {:.2}.\nReferencia: {}.\n\nPuedes revisar tus pagos y cancelar la renovación mensual desde tu cuenta de Aule.",
            row.amount_cents as f64 / 100.0,
            order.id
        )
    };
    let body = if order.kind == "device" && row.status == "approved" {
        format!(
            "{state_text}.\n\nS/ {:.2} · {}\n\n{}\n\n{}",
            row.amount_cents as f64 / 100.0,
            order.id,
            if en {
                "Delivery included within 30 days, in Lima Metropolitana and Callao. Includes three months of tutoring per device. Sign in with this email to activate them; no automatic renewal is started."
            } else {
                "Envío incluido en hasta 30 días, a Lima Metropolitana y Callao. Incluye tres meses de tutoría por dispositivo. Entra con este correo para activarlos; no se inicia una renovación automática."
            },
            state.config.payments.as_ref().map(|p| p.public_url.as_str()).unwrap_or_default()
        )
    } else {
        body
    };
    mailer
        .send(email, &format!("Aule · {state_text}"), &body)
        .await
        .map_err(|_| ApiError::Unavailable("payment receipt email failed"))?;
    use sea_orm::ActiveModelTrait;
    let status = row.status.clone();
    let mut update = row.into_active_model();
    update.notified_status = Set(Some(status));
    update.update(&txn).await?;
    txn.commit().await?;
    Ok(())
}

fn store_authorized(settings: &Payments, headers: &HeaderMap) -> ApiResult<()> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !same_token(token, &settings.store_token) {
        return Err(ApiError::Unauthorized);
    }
    Ok(())
}
pub async fn catalog(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let (settings, _) = configured(&state)?;
    store_authorized(settings, &headers)?;
    Ok(Json(
        json!({ "available": settings.device_price_cents.is_some(), "price_cents": settings.device_price_cents, "shipping_cents": settings.shipping_cents, "currency": CURRENCY, "delivery": settings.delivery, "included_months": 3, "coverage": ["Lima Metropolitana", "Callao"] }),
    ))
}
#[derive(Deserialize)]
pub struct DeviceOrder {
    pub id: Uuid,
    pub quantity: i32,
    pub quoted_total_cents: i64,
    pub accept_terms: bool,
    pub buyer: Value,
    #[serde(default)]
    pub language: String,
}
fn buyer_email(buyer: &Value) -> ApiResult<String> {
    for (key, min, max) in [
        ("nombres", 2, 120),
        ("apellidos", 2, 120),
        ("email", 5, 254),
        ("telefono", 6, 30),
        ("direccion", 4, 300),
        ("distrito", 2, 100),
        ("provincia", 2, 100),
        ("departamento", 2, 100),
        ("documento", 8, 11),
        ("comprobante", 6, 7),
    ] {
        let value = buyer[key].as_str().unwrap_or_default();
        if value.trim().len() < min || value.len() > max {
            return Err(ApiError::bad_request("invalid order details"));
        }
    }
    for key in ["razonSocial", "referencia"] {
        if buyer[key].as_str().is_some_and(|v| v.len() > 500) {
            return Err(ApiError::bad_request("order details too long"));
        }
    }
    let email = crate::signin::normalized_email(buyer["email"].as_str().unwrap_or_default())?;
    let doc = buyer["documento"].as_str().unwrap_or_default();
    if buyer["comprobante"] == "factura" && buyer["razonSocial"].as_str().unwrap_or_default().trim().len() < 2
    {
        return Err(ApiError::bad_request("company name is required"));
    }
    let place = |name: &str| buyer[name].as_str().unwrap_or_default().trim().to_lowercase();
    if !matches!(
        (place("departamento").as_str(), place("provincia").as_str()),
        ("lima", "lima") | ("callao", "callao")
    ) {
        return Err(ApiError::bad_request("delivery is available only in Lima Metropolitana and Callao"));
    }
    if !doc.bytes().all(|v| v.is_ascii_digit())
        || !matches!((buyer["comprobante"].as_str(), doc.len()), (Some("boleta"), 8) | (Some("factura"), 11))
    {
        return Err(ApiError::bad_request("invalid document"));
    }
    Ok(email)
}
pub async fn device_order(
    State(state): State<AppState>,
    headers: HeaderMap,
    Input(body): Input<DeviceOrder>,
) -> ApiResult<Json<Value>> {
    let (settings, gateway) = configured(&state)?;
    store_authorized(settings, &headers)?;
    let unit = settings.device_price_cents.ok_or(ApiError::Unavailable("device sales are not open"))?;
    if !(1..=10).contains(&body.quantity) {
        return Err(ApiError::bad_request("quantity must be between 1 and 10"));
    }
    let total = unit * i64::from(body.quantity) + settings.shipping_cents;
    if !body.accept_terms {
        return Err(ApiError::bad_request("purchase terms must be accepted"));
    }
    if body.quoted_total_cents != total {
        return Err(ApiError::Conflict("the price changed; reload checkout before paying"));
    }
    let email = buyer_email(&body.buyer)?;
    let mut buyer = json!({});
    for key in [
        "nombres",
        "apellidos",
        "email",
        "telefono",
        "direccion",
        "distrito",
        "provincia",
        "departamento",
        "referencia",
        "documento",
        "comprobante",
        "razonSocial",
    ] {
        if let Some(value) = body.buyer[key].as_str() {
            buyer[key] = json!(value.trim());
        }
    }
    buyer["email"] = json!(email);
    buyer["offer"] = json!({"unit_cents":unit,"shipping_cents":settings.shipping_cents,"included_months_per_device":3,"delivery":settings.delivery,"coverage":["Lima Metropolitana","Callao"],"terms_accepted":true});
    let _order_lock = family_lock(&state, body.id).await?;
    if let Some(row) = checkout::Entity::find_by_id(body.id).one(&state.db).await? {
        if row.buyer != buyer || row.quantity != body.quantity || row.kind != "device" {
            return Err(ApiError::Conflict("checkout key already used"));
        }
        if row.provider_id.is_some() {
            return Ok(Json(public_checkout(&row)));
        }
        let hosted = gateway
            .find_order(row.id)
            .await
            .map_err(provider)?
            .ok_or(ApiError::Unavailable("checkout is being confirmed; try again shortly"))?;
        use sea_orm::ActiveModelTrait;
        let mut update = row.into_active_model();
        update.provider_id = Set(Some(hosted.id));
        update.checkout_url = Set(Some(hosted.url));
        update.status = Set("pending".into());
        return Ok(Json(public_checkout(&update.update(&state.db).await?)));
    }
    let now = Utc::now();
    use sea_orm::ActiveModelTrait;
    let mut row = checkout::ActiveModel {
        id: Set(body.id),
        family_id: Set(None),
        active_family_id: Set(None),
        kind: Set("device".into()),
        included_months: Set(3 * body.quantity),
        activated_at: Set(None),
        amount_cents: Set(unit * i64::from(body.quantity) + settings.shipping_cents),
        quantity: Set(body.quantity),
        currency: Set(CURRENCY.into()),
        language: Set(language(&body.language).into()),
        buyer: Set(buyer),
        status: Set("creating".into()),
        provider_id: Set(None),
        checkout_url: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        checked_at: Set(None),
        cancelled_at: Set(None),
    }
    .insert(&state.db)
    .await?;
    let hosted = gateway
        .create_order(row.id, &email, row.quantity, unit, settings.shipping_cents)
        .await
        .map_err(provider)?;
    let mut update = row.into_active_model();
    update.provider_id = Set(Some(hosted.id));
    update.checkout_url = Set(Some(hosted.url));
    update.status = Set("pending".into());
    row = update.update(&state.db).await?;
    Ok(Json(public_checkout(&row)))
}
#[derive(Deserialize)]
pub struct OrderQuery {
    pub id: Uuid,
}
pub async fn order_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<OrderQuery>,
) -> ApiResult<Json<Value>> {
    let (settings, _) = configured(&state)?;
    store_authorized(settings, &headers)?;
    let row = checkout::Entity::find_by_id(query.id)
        .filter(checkout::Column::Kind.eq("device"))
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound("order"))?;
    Ok(Json(
        json!({ "id": row.id, "status": row.status, "amount_cents": row.amount_cents, "currency": row.currency, "quantity": row.quantity, "delivery": row.buyer["offer"]["delivery"], "included_months": row.included_months, "coverage": row.buyer["offer"]["coverage"] }),
    ))
}
pub async fn orders(_: Staff, State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rows = checkout::Entity::find()
        .filter(checkout::Column::Kind.eq("device"))
        .order_by_desc(checkout::Column::CreatedAt)
        .limit(100)
        .all(&state.db)
        .await?;
    Ok(Json(
        json!({ "orders": rows.iter().map(|row| json!({ "id": row.id, "created_at": row.created_at, "status": row.status, "quantity": row.quantity, "amount_cents": row.amount_cents, "currency": row.currency, "buyer": row.buyer })).collect::<Vec<_>>() }),
    ))
}

/// Serializes purchase, cancellation and erasure for an account across processes.
/// The separate transaction keeps the lock while durable checkout writes commit.
pub async fn family_lock(state: &AppState, id: Uuid) -> ApiResult<sea_orm::DatabaseTransaction> {
    let txn = state.db.begin().await?;
    txn.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select pg_advisory_xact_lock(hashtextextended($1, 91826))",
        [id.to_string().into()],
    ))
    .await?;
    Ok(txn)
}

#[derive(Deserialize)]
pub struct Redeem {
    pub order_id: Uuid,
    pub cancel_renewal: bool,
}
/// The verified buyer activates the included months. Never enrolls them in renewal.
pub async fn redeem(
    guardian: Guardian,
    State(state): State<AppState>,
    Input(body): Input<Redeem>,
) -> ApiResult<Json<Value>> {
    if state.config.free_access {
        return Err(ApiError::Conflict("included months stay reserved while free access is enabled"));
    }
    if !body.cancel_renewal {
        return Err(ApiError::bad_request("confirm that existing monthly renewal will stop"));
    }
    let _billing_lock = family_lock(&state, guardian.family_id).await?;
    let adult =
        guardian::Entity::find_by_id(guardian.id).one(&state.db).await?.ok_or(ApiError::Unauthorized)?;
    let row = checkout::Entity::find_by_id(body.order_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound("order"))?;
    if row.kind != "device"
        || row.buyer["email"].as_str().is_none_or(|v| !v.eq_ignore_ascii_case(&adult.email))
        || row.family_id.is_some_and(|id| id != guardian.family_id)
    {
        return Err(ApiError::NotFound("order"));
    }
    if row.activated_at.is_some() {
        return mine(guardian, State(state.clone())).await;
    }
    if row.status != "approved" {
        return Err(ApiError::Conflict("the device payment must be confirmed first"));
    }
    cancel_family(&state, guardian.family_id).await?;
    let txn = state.db.begin().await?;
    let row = checkout::Entity::find_by_id(body.order_id)
        .lock_exclusive()
        .one(&txn)
        .await?
        .ok_or(ApiError::NotFound("order"))?;
    if row.activated_at.is_none() {
        let receipt = payment::Entity::find()
            .filter(payment::Column::CheckoutId.eq(row.id))
            .filter(payment::Column::Status.eq("approved"))
            .order_by_asc(payment::Column::ApprovedAt)
            .one(&txn)
            .await?
            .ok_or(ApiError::Conflict("the device payment must be confirmed first"))?;
        let now = Utc::now();
        // Keep any time already paid for. Included months begin after it.
        let existing = subscription::Entity::find()
            .filter(subscription::Column::FamilyId.eq(guardian.family_id))
            .filter(subscription::Column::EndsAt.gt(now))
            .order_by_desc(subscription::Column::EndsAt)
            .one(&txn)
            .await?;
        let start = existing.map_or(now, |s| s.ends_at);
        let end = start
            .checked_add_months(Months::new(row.included_months as u32))
            .ok_or(ApiError::bad_request("invalid included period"))?;
        let id = Uuid::new_v4();
        subscription::Entity::insert(subscription::ActiveModel {
            id: Set(id),
            family_id: Set(guardian.family_id),
            plan: Set("paid".into()),
            starts_at: Set(start),
            ends_at: Set(end),
            payment_token: Set(None),
            provider_subscription: Set(None),
            cancelled_at: Set(None),
            granted_by: Set(None),
            note: Set(Some("Months included with device purchase".into())),
            created_at: Set(now),
        })
        .exec(&txn)
        .await?;
        use sea_orm::ActiveModelTrait;
        let mut paid = receipt.into_active_model();
        paid.access_id = Set(Some(id));
        paid.update(&txn).await?;
        let mut order = row.into_active_model();
        order.family_id = Set(Some(guardian.family_id));
        order.activated_at = Set(Some(now));
        order.update(&txn).await?;
    }
    txn.commit().await?;
    mine(guardian, State(state.clone())).await
}

async fn included_until(state: &AppState, family_id: Uuid) -> ApiResult<Option<chrono::DateTime<Utc>>> {
    let row = state.db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select max(s.ends_at) as until from subscriptions s join billing_payments p on p.access_id = s.id join billing_checkouts c on c.id = p.checkout_id where s.family_id = $1 and c.kind = 'device' and p.status = 'approved' and s.ends_at > now()", [family_id.into()])).await?;
    Ok(row.map(|row| row.try_get("", "until")).transpose()?.flatten())
}

pub async fn send_order_notice(state: &AppState, id: &str) -> ApiResult<()> {
    let (settings, _) = configured(state)?;
    let mailer = state.mailer.as_ref().ok_or(ApiError::Unavailable("order email is unavailable"))?;
    let txn = state.db.begin().await?;
    let Some(paid) = payment::Entity::find_by_id(id.to_string()).lock_exclusive().one(&txn).await? else {
        return Ok(());
    };
    if paid.merchant_notified_status.as_deref() == Some(&paid.status) {
        return Ok(());
    }
    let order =
        checkout::Entity::find_by_id(paid.checkout_id).one(&txn).await?.ok_or(ApiError::NotFound("order"))?;
    let mut body = format!(
        "Order: {}\nPayment: {}\nStatus: {}\nUnits: {}\nTotal: S/ {:.2}\nDelivery: {}\n",
        order.id,
        paid.id,
        paid.status,
        order.quantity,
        order.amount_cents as f64 / 100.0,
        order.buyer["offer"]["delivery"].as_str().unwrap_or_default()
    );
    for key in [
        "nombres",
        "apellidos",
        "email",
        "telefono",
        "direccion",
        "distrito",
        "provincia",
        "departamento",
        "referencia",
        "comprobante",
        "documento",
        "razonSocial",
    ] {
        if let Some(value) = order.buyer[key].as_str() {
            body.push_str(&format!("{key}: {value}\n"));
        }
    }
    body.push_str("\nConfirm approval in the team panel before dispatch. Issue the requested tax receipt through the company's invoicing process.\n");
    mailer
        .send(&settings.orders_email, &format!("Aule · order {} · {}", order.id, paid.status), &body)
        .await
        .map_err(|_| ApiError::Unavailable("order email failed"))?;
    use sea_orm::ActiveModelTrait;
    let status = paid.status.clone();
    let mut updated = paid.into_active_model();
    updated.merchant_notified_status = Set(Some(status));
    updated.update(&txn).await?;
    txn.commit().await?;
    Ok(())
}
