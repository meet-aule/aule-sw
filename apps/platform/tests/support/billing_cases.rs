use super::*;
use aule_platform::billing::{self, gateway::*};
use aule_platform::config::Payments;
use aule_platform::entity::{billing_checkout as checkout, billing_payment as payment, subscription};
use chrono::{Months, Utc};
use sea_orm::{EntityTrait, PaginatorTrait};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use uuid::Uuid;

#[derive(Default)]
struct Provider {
    agreements: Mutex<HashMap<Uuid, Agreement>>,
    orders: Mutex<HashMap<Uuid, Hosted>>,
    payments: Mutex<HashMap<u64, Payment>>,
    creates: AtomicUsize,
    lose_create: AtomicBool,
    cancel_down: AtomicBool,
}
fn agreement(id: Uuid) -> Agreement {
    Agreement {
        id: id.simple().to_string(),
        external_reference: reference(id),
        collector_id: 7,
        status: "pending".into(),
        auto_recurring: Recurring {
            frequency: 1,
            frequency_type: "months".into(),
            transaction_amount: 59.0,
            currency_id: "PEN".into(),
        },
        init_point: Some("https://www.mercadopago.com.pe/subscriptions/checkout".into()),
    }
}
#[async_trait]
impl Gateway for Provider {
    async fn create_agreement(&self, id: Uuid, _: &str) -> Result<Agreement> {
        self.creates.fetch_add(1, Ordering::SeqCst);
        let row = agreement(id);
        self.agreements.lock().unwrap().insert(id, row.clone());
        if self.lose_create.load(Ordering::SeqCst) {
            return Err(GatewayError::Unavailable);
        }
        Ok(row)
    }
    async fn find_agreement(&self, id: Uuid) -> Result<Option<Agreement>> {
        Ok(self.agreements.lock().unwrap().get(&id).cloned())
    }
    async fn agreement(&self, id: &str) -> Result<Agreement> {
        self.agreements.lock().unwrap().values().find(|a| a.id == id).cloned().ok_or(GatewayError::Invalid)
    }
    async fn cancel(&self, id: &str) -> Result<Agreement> {
        if self.cancel_down.load(Ordering::SeqCst) {
            return Err(GatewayError::Unavailable);
        }
        let mut rows = self.agreements.lock().unwrap();
        let row = rows.values_mut().find(|a| a.id == id).ok_or(GatewayError::Invalid)?;
        row.status = "cancelled".into();
        Ok(row.clone())
    }
    async fn payment(&self, id: &str) -> Result<Payment> {
        self.payments
            .lock()
            .unwrap()
            .get(&id.parse().map_err(|_| GatewayError::Invalid)?)
            .cloned()
            .ok_or(GatewayError::Invalid)
    }
    async fn invoice(&self, _: &str) -> Result<Invoice> {
        Err(GatewayError::Invalid)
    }
    async fn invoices(&self, id: &str) -> Result<Vec<Invoice>> {
        let order = Uuid::parse_str(id).map_err(|_| GatewayError::Invalid)?;
        Ok(self
            .payments
            .lock()
            .unwrap()
            .values()
            .filter(|p| p.external_reference == Some(reference(order)))
            .map(|p| Invoice { preapproval_id: id.into(), payment: Some(InvoicePayment { id: p.id }) })
            .collect())
    }
    async fn create_order(&self, id: Uuid, _: &str, _: i32, _: i64, _: i64) -> Result<Hosted> {
        self.creates.fetch_add(1, Ordering::SeqCst);
        let row = Hosted {
            id: id.simple().to_string(),
            url: "https://sandbox.mercadopago.com.pe/checkout/v1/redirect".into(),
        };
        self.orders.lock().unwrap().insert(id, row.clone());
        if self.lose_create.load(Ordering::SeqCst) {
            return Err(GatewayError::Unavailable);
        }
        Ok(row)
    }
    async fn find_order(&self, id: Uuid) -> Result<Option<Hosted>> {
        Ok(self.orders.lock().unwrap().get(&id).cloned())
    }
    async fn order_payments(&self, id: Uuid) -> Result<Vec<Payment>> {
        Ok(self
            .payments
            .lock()
            .unwrap()
            .values()
            .filter(|p| p.external_reference == Some(reference(id)))
            .cloned()
            .collect())
    }
}
fn configured(pool: PgPool) -> (App, Arc<Provider>) {
    let mut app = app(pool);
    Arc::make_mut(&mut app.state.config).payments = Some(Payments {
        access_token: "test-only-token".into(),
        webhook_secret: "test-only-signature".into(),
        collector_id: 7,
        live_mode: false,
        public_url: "https://page.example.org".into(),
        store_url: "https://store.example.org".into(),
        store_token: "test-store-token-at-least-32-characters".into(),
        device_price_cents: Some(10000),
        shipping_cents: 0,
        delivery: "Within 30 days, Lima Metropolitana and Callao".into(),
        orders_email: "orders@example.org".into(),
    });
    let provider = Arc::new(Provider::default());
    app.state.payments = Some(provider.clone());
    app.router = http::router(app.state.clone());
    (app, provider)
}
async fn subscribe(app: &App, token: &str) -> checkout::Model {
    let (status, value) = app
        .call(
            Method::POST,
            "/v1/me/billing/subscribe",
            Some(token),
            Some(json!({"accept_recurring":true,"language":"es"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    checkout::Entity::find_by_id(value["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .one(&app.state.db)
        .await
        .unwrap()
        .unwrap()
}
fn approved(row: &checkout::Model, id: u64) -> Payment {
    Payment {
        id,
        collector_id: 7,
        live_mode: false,
        status: "approved".into(),
        external_reference: Some(reference(row.id)),
        transaction_amount: row.amount_cents as f64 / 100.0,
        transaction_amount_refunded: 0.0,
        currency_id: "PEN".into(),
        date_approved: Some(Utc::now()),
    }
}
#[sqlx::test(migrator = "aule_platform::MIGRATOR")]
async fn billing_receipts_are_verified_once_and_refunds_cannot_be_replayed(pool: PgPool) {
    let (app, _) = configured(pool);
    let token = app.sign_in("buyer@example.org", "Buyer").await;
    let row = subscribe(&app, &token).await;
    let paid = approved(&row, 100);
    for bad in [
        Payment { collector_id: 8, ..paid.clone() },
        Payment { live_mode: true, ..paid.clone() },
        Payment { currency_id: "USD".into(), ..paid.clone() },
        Payment { transaction_amount: 58.0, ..paid.clone() },
        Payment { external_reference: Some(reference(Uuid::new_v4())), ..paid.clone() },
    ] {
        assert!(billing::apply_payment(&app.state, &row, bad).await.is_err());
    }
    assert_eq!(subscription::Entity::find().count(&app.state.db).await.unwrap(), 0);
    let (a, b) = tokio::join!(
        billing::apply_payment(&app.state, &row, paid.clone()),
        billing::apply_payment(&app.state, &row, paid.clone())
    );
    a.unwrap();
    b.unwrap();
    let periods = subscription::Entity::find().all(&app.state.db).await.unwrap();
    assert_eq!(periods.len(), 1);
    // PostgreSQL stores microseconds; Linux's clock can supply nanoseconds.
    assert_eq!(
        periods[0].ends_at.timestamp_micros(),
        paid.date_approved.unwrap().checked_add_months(Months::new(1)).unwrap().timestamp_micros()
    );
    billing::apply_payment(&app.state, &row, Payment { status: "pending".into(), ..paid.clone() })
        .await
        .unwrap();
    assert_eq!(
        payment::Entity::find_by_id("100").one(&app.state.db).await.unwrap().unwrap().status,
        "approved"
    );
    billing::apply_payment(
        &app.state,
        &row,
        Payment { status: "refunded".into(), transaction_amount_refunded: 59.0, ..paid.clone() },
    )
    .await
    .unwrap();
    billing::apply_payment(&app.state, &row, paid).await.unwrap();
    assert_eq!(subscription::Entity::find().count(&app.state.db).await.unwrap(), 0);
    assert_eq!(
        payment::Entity::find_by_id("100").one(&app.state.db).await.unwrap().unwrap().status,
        "refunded"
    );
}
#[sqlx::test(migrator = "aule_platform::MIGRATOR")]
async fn billing_recovers_ambiguous_creation_and_cancellation_keeps_paid_time(pool: PgPool) {
    let (app, provider) = configured(pool);
    let token = app.sign_in("buyer@example.org", "Buyer").await;
    provider.lose_create.store(true, Ordering::SeqCst);
    let body = Some(json!({"accept_recurring":true}));
    assert_eq!(
        app.call(Method::POST, "/v1/me/billing/subscribe", Some(&token), body).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let row = subscribe(&app, &token).await;
    assert_eq!(provider.creates.load(Ordering::SeqCst), 1);
    billing::apply_payment(&app.state, &row, approved(&row, 101)).await.unwrap();
    assert_eq!(
        app.call(Method::POST, "/v1/me/billing/cancel", Some(&token), Some(json!({}))).await.0,
        StatusCode::OK
    );
    assert_eq!(subscription::Entity::find().count(&app.state.db).await.unwrap(), 1);
    let state = checkout::Entity::find_by_id(row.id).one(&app.state.db).await.unwrap().unwrap();
    assert!(state.cancelled_at.is_some());
}
#[sqlx::test(migrator = "aule_platform::MIGRATOR")]
async fn billing_refuses_account_erasure_until_remote_renewal_has_stopped(pool: PgPool) {
    let (app, provider) = configured(pool);
    let token = app.sign_in("buyer@example.org", "Buyer").await;
    let row = subscribe(&app, &token).await;
    provider.cancel_down.store(true, Ordering::SeqCst);
    let erase = Some(json!({"confirm_email":"buyer@example.org"}));
    assert_eq!(
        app.call(Method::DELETE, "/v1/me", Some(&token), erase.clone()).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    provider.cancel_down.store(false, Ordering::SeqCst);
    assert_eq!(app.call(Method::DELETE, "/v1/me", Some(&token), erase).await.0, StatusCode::NO_CONTENT);
    let saved = checkout::Entity::find_by_id(row.id).one(&app.state.db).await.unwrap().unwrap();
    assert!(saved.family_id.is_none());
    assert_eq!(saved.buyer, json!({}));
    assert!(saved.cancelled_at.is_some());
}
fn order(id: Uuid) -> Value {
    json!({"id":id,"quantity":1,"quoted_total_cents":10000,"accept_terms":true,"language":"es","buyer":{"nombres":"Test","apellidos":"Buyer","email":"buyer@example.org","telefono":"999999999","direccion":"Test street 123","distrito":"San Miguel","provincia":"Lima","departamento":"Lima","comprobante":"boleta","documento":"12345678"}})
}
const STORE: &str = "test-store-token-at-least-32-characters";
#[sqlx::test(migrator = "aule_platform::MIGRATOR")]
async fn billing_device_price_coverage_free_reservation_and_redemption_are_enforced(pool: PgPool) {
    let (mut app, provider) = configured(pool);
    let token = app.sign_in("buyer@example.org", "Buyer").await;
    let stranger = app.sign_in("stranger@example.org", "Other").await;
    let id = Uuid::new_v4();
    let mut body = order(id);
    body["amount_cents"] = json!(1);
    let mut wrong_price = order(Uuid::new_v4());
    wrong_price["quoted_total_cents"] = json!(1);
    assert_eq!(
        app.call(Method::POST, "/v1/store/orders", Some(STORE), Some(wrong_price)).await.0,
        StatusCode::CONFLICT
    );
    let mut far = order(Uuid::new_v4());
    far["buyer"]["provincia"] = json!("Huaral");
    assert_eq!(
        app.call(Method::POST, "/v1/store/orders", Some(STORE), Some(far)).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        app.call(Method::POST, "/v1/store/orders", Some(&token), Some(body.clone())).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (a, b) = tokio::join!(
        app.call(Method::POST, "/v1/store/orders", Some(STORE), Some(body.clone())),
        app.call(Method::POST, "/v1/store/orders", Some(STORE), Some(body))
    );
    assert_eq!(a.0, StatusCode::OK, "{}", a.1);
    assert_eq!(b.0, StatusCode::OK, "{}", b.1);
    assert_eq!(provider.creates.load(Ordering::SeqCst), 1);
    let row = checkout::Entity::find_by_id(id).one(&app.state.db).await.unwrap().unwrap();
    assert_eq!(row.amount_cents, 10000);
    let redeem = Some(json!({"order_id":id,"cancel_renewal":true}));
    assert_eq!(
        app.call(Method::POST, "/v1/me/billing/redeem", Some(&token), redeem.clone()).await.0,
        StatusCode::CONFLICT
    );
    billing::apply_payment(&app.state, &row, approved(&row, 102)).await.unwrap();
    assert_eq!(
        app.call(Method::POST, "/v1/me/billing/redeem", Some(&stranger), redeem.clone()).await.0,
        StatusCode::NOT_FOUND
    );
    Arc::make_mut(&mut app.state.config).free_access = true;
    app.router = http::router(app.state.clone());
    assert_eq!(
        app.call(Method::POST, "/v1/me/billing/redeem", Some(&token), redeem.clone()).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(subscription::Entity::find().count(&app.state.db).await.unwrap(), 0);
    Arc::make_mut(&mut app.state.config).free_access = false;
    app.router = http::router(app.state.clone());
    assert_eq!(
        app.call(Method::POST, "/v1/me/billing/redeem", Some(&token), redeem.clone()).await.0,
        StatusCode::OK
    );
    assert_eq!(app.call(Method::POST, "/v1/me/billing/redeem", Some(&token), redeem).await.0, StatusCode::OK);
    let periods = subscription::Entity::find().all(&app.state.db).await.unwrap();
    assert_eq!(periods.len(), 1);
    assert_eq!(periods[0].ends_at, periods[0].starts_at.checked_add_months(Months::new(3)).unwrap());
    let paid = approved(&row, 102);
    billing::apply_payment(
        &app.state,
        &row,
        Payment { status: "refunded".into(), transaction_amount_refunded: 100.0, ..paid },
    )
    .await
    .unwrap();
    assert_eq!(subscription::Entity::find().count(&app.state.db).await.unwrap(), 0);
}
#[sqlx::test(migrator = "aule_platform::MIGRATOR")]
async fn billing_reconciliation_finds_a_payment_without_a_webhook(pool: PgPool) {
    let (app, provider) = configured(pool);
    let token = app.sign_in("buyer@example.org", "Buyer").await;
    let row = subscribe(&app, &token).await;
    provider.payments.lock().unwrap().insert(103, approved(&row, 103));
    billing::reconcile_checkout(&app.state, row.id).await.unwrap();
    billing::reconcile_checkout(&app.state, row.id).await.unwrap();
    assert_eq!(subscription::Entity::find().count(&app.state.db).await.unwrap(), 1);
}
#[test]
fn billing_signatures_and_checkout_hosts_fail_closed() {
    use hmac::{Hmac, KeyInit, Mac};
    use sha2::Sha256;
    let mut mac = Hmac::<Sha256>::new_from_slice(b"test-only").unwrap();
    mac.update(b"id:abc123;request-id:event-1;ts:1700000000;");
    let signature = format!("ts=1700000000,v1={}", hex::encode(mac.finalize().into_bytes()));
    assert!(billing::valid_signature("test-only", &signature, "event-1", "ABC123", 1700000000));
    for (request, id, now) in
        [("event-2", "ABC123", 1700000000), ("event-1", "999", 1700000000), ("event-1", "ABC123", 1700000301)]
    {
        assert!(!billing::valid_signature("test-only", &signature, request, id, now));
    }
    for url in [
        "http://www.mercadopago.com.pe/",
        "https://www.mercadopago.com.pe.evil.test/",
        "https://attacker@www.mercadopago.com.pe/",
    ] {
        assert!(!safe_checkout(url));
    }
}

#[sqlx::test(migrator = "aule_platform::MIGRATOR")]
async fn billing_webhook_commits_work_before_answer_and_worker_grants_once(pool: PgPool) {
    use hmac::{Hmac, KeyInit, Mac};
    use sha2::Sha256;
    let (app, provider) = configured(pool);
    let token = app.sign_in("buyer@example.org", "Buyer").await;
    let row = subscribe(&app, &token).await;
    provider.payments.lock().unwrap().insert(104, approved(&row, 104));
    let ts = Utc::now().timestamp();
    let mut mac = Hmac::<Sha256>::new_from_slice(b"test-only-signature").unwrap();
    mac.update(format!("id:104;request-id:event-1;ts:{ts};").as_bytes());
    let signature = format!("ts={ts},v1={}", hex::encode(mac.finalize().into_bytes()));
    for signed in [false, true, true] {
        let request = Request::builder()
            .method(Method::POST)
            .uri("/v1/payments/webhook?data.id=104")
            .header("Content-Type", "application/json")
            .header("x-request-id", "event-1")
            .header("x-signature", if signed { &signature } else { "bad" })
            .body(Body::from(json!({"type":"payment","data":{"id":104}}).to_string()))
            .unwrap();
        let response = app.router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), if signed { StatusCode::OK } else { StatusCode::UNAUTHORIZED });
    }
    assert_eq!(app.count("select count(*) from jobs where kind = 'reconcile_payment'").await, 2);
    assert_eq!(subscription::Entity::find().count(&app.state.db).await.unwrap(), 0);
    while jobs::work_once(&app.state).await.unwrap() {}
    assert_eq!(subscription::Entity::find().count(&app.state.db).await.unwrap(), 1);
    let saved = payment::Entity::find_by_id("104").one(&app.state.db).await.unwrap().unwrap();
    assert_eq!(saved.notified_status.as_deref(), Some("approved"));
}

#[test]
fn billing_accepts_provider_decimal_strings_and_normalizes_cancellation() {
    let value = json!({"id":"abc123", "external_reference":"aule:test", "collector_id":7, "status":"canceled", "auto_recurring":{"frequency":1,"frequency_type":"months","transaction_amount":"59.00","currency_id":"PEN"}});
    let parsed: Agreement = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(parsed.status, "cancelled");
    assert_eq!(cents(parsed.auto_recurring.transaction_amount), Some(5900));
    for invalid in ["NaN", "Infinity", "59.001", "-1"] {
        let mut value = value.clone();
        value["auto_recurring"]["transaction_amount"] = json!(invalid);
        assert!(serde_json::from_value::<Agreement>(value).is_err());
    }
}
