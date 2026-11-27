//! Hosted Mercado Pago checkout. The server never receives a card or its token.
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use reqwest::{Client, Method};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::config::Payments;
use crate::plans::{CURRENCY, PRICE_CENTS};

#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    #[error("payment provider unavailable")]
    Unavailable,
    #[error("payment provider rejected the request ({0})")]
    Rejected(u16),
    #[error("payment provider returned an invalid response")]
    Invalid,
}
pub type Result<T> = std::result::Result<T, GatewayError>;

// Mercado Pago returns money as a JSON number or a decimal string, depending
// on the endpoint. Both are still checked as exact cents before granting access.
fn money<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<f64, D::Error> {
    let value = Value::deserialize(deserializer)?;
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|v| v.parse().ok()))
        .filter(|n| cents(*n).is_some())
        .ok_or_else(|| serde::de::Error::custom("invalid money amount"))
}

fn status<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    Ok(if value == "canceled" { "cancelled".into() } else { value })
}

#[derive(Clone, Debug, Deserialize)]
pub struct Recurring {
    pub frequency: u32,
    pub frequency_type: String,
    #[serde(deserialize_with = "money")]
    pub transaction_amount: f64,
    pub currency_id: String,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Agreement {
    pub id: String,
    pub external_reference: String,
    pub collector_id: u64,
    #[serde(deserialize_with = "status")]
    pub status: String,
    pub auto_recurring: Recurring,
    pub init_point: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Payment {
    pub id: u64,
    pub collector_id: u64,
    pub live_mode: bool,
    #[serde(deserialize_with = "status")]
    pub status: String,
    pub external_reference: Option<String>,
    #[serde(deserialize_with = "money")]
    pub transaction_amount: f64,
    #[serde(default, deserialize_with = "money")]
    pub transaction_amount_refunded: f64,
    pub currency_id: String,
    pub date_approved: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct InvoicePayment {
    pub id: u64,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Invoice {
    pub preapproval_id: String,
    pub payment: Option<InvoicePayment>,
}
#[derive(Clone, Debug)]
pub struct Hosted {
    pub id: String,
    pub url: String,
}

pub fn reference(id: Uuid) -> String {
    format!("aule:{id}")
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
pub fn cents(amount: f64) -> Option<i64> {
    let scaled = amount * 100.0;
    (scaled.is_finite()
        && (0.0..=1_000_000_000.0).contains(&scaled)
        && (scaled - scaled.round()).abs() < 0.00001)
        .then_some(scaled.round() as i64)
}
pub fn safe_checkout(url: &str) -> bool {
    reqwest::Url::parse(url).ok().is_some_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.port().is_none()
            && matches!(u.host_str(), Some("www.mercadopago.com.pe" | "sandbox.mercadopago.com.pe"))
    })
}

#[async_trait]
pub trait Gateway: Send + Sync {
    async fn create_agreement(&self, id: Uuid, email: &str) -> Result<Agreement>;
    async fn find_agreement(&self, id: Uuid) -> Result<Option<Agreement>>;
    async fn agreement(&self, id: &str) -> Result<Agreement>;
    async fn cancel(&self, id: &str) -> Result<Agreement>;
    async fn payment(&self, id: &str) -> Result<Payment>;
    async fn invoice(&self, id: &str) -> Result<Invoice>;
    async fn invoices(&self, id: &str) -> Result<Vec<Invoice>>;
    async fn create_order(
        &self,
        id: Uuid,
        email: &str,
        quantity: i32,
        unit_cents: i64,
        shipping_cents: i64,
    ) -> Result<Hosted>;
    async fn find_order(&self, id: Uuid) -> Result<Option<Hosted>>;
    async fn order_payments(&self, id: Uuid) -> Result<Vec<Payment>>;
}

pub struct MercadoPago {
    client: Client,
    settings: Payments,
}
impl MercadoPago {
    pub fn new(settings: Payments) -> Self {
        Self { client: Client::new(), settings }
    }
    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        key: Option<Uuid>,
        query: &[(&str, String)],
    ) -> Result<Value> {
        let mut url = reqwest::Url::parse(&format!("https://api.mercadopago.com{path}"))
            .map_err(|_| GatewayError::Invalid)?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(&self.settings.access_token)
            .timeout(std::time::Duration::from_secs(8));
        if let Some(body) = body {
            request = request.json(&body);
        }
        if let Some(key) = key {
            request = request.header("X-Idempotency-Key", key.to_string());
        }
        let response = request.send().await.map_err(|_| GatewayError::Unavailable)?;
        if !response.status().is_success() {
            return Err(GatewayError::Rejected(response.status().as_u16()));
        }
        response.json().await.map_err(|_| GatewayError::Invalid)
    }
    async fn resource<T: serde::de::DeserializeOwned>(&self, base: &str, id: &str) -> Result<T> {
        if !valid_id(id) {
            return Err(GatewayError::Invalid);
        }
        serde_json::from_value(self.request(Method::GET, &format!("{base}/{id}"), None, None, &[]).await?)
            .map_err(|_| GatewayError::Invalid)
    }
    async fn search<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        filter: (&str, String),
    ) -> Result<Vec<T>> {
        let mut result = Vec::new();
        // A bounded page loop avoids a provider error tying up the worker forever.
        for page in 0..100 {
            let value = self
                .request(
                    Method::GET,
                    path,
                    None,
                    None,
                    &[
                        (filter.0, filter.1.clone()),
                        ("limit", "100".into()),
                        ("offset", (page * 100).to_string()),
                    ],
                )
                .await?;
            let rows: Vec<T> =
                serde_json::from_value(value.get("results").cloned().ok_or(GatewayError::Invalid)?)
                    .map_err(|_| GatewayError::Invalid)?;
            let length = rows.len();
            result.extend(rows);
            if length < 100 {
                return Ok(result);
            }
        }
        Err(GatewayError::Invalid)
    }
}

#[async_trait]
impl Gateway for MercadoPago {
    async fn create_agreement(&self, id: Uuid, email: &str) -> Result<Agreement> {
        let body = json!({ "reason": "Aule — tutoría mensual", "external_reference": reference(id), "payer_email": email,
            "auto_recurring": { "frequency": 1, "frequency_type": "months", "transaction_amount": PRICE_CENTS as f64 / 100.0, "currency_id": CURRENCY },
            "back_url": format!("{}/?billing=return", self.settings.public_url), "status": "pending" });
        serde_json::from_value(self.request(Method::POST, "/preapproval", Some(body), Some(id), &[]).await?)
            .map_err(|_| GatewayError::Invalid)
    }
    async fn find_agreement(&self, id: Uuid) -> Result<Option<Agreement>> {
        let mut rows: Vec<Agreement> =
            self.search("/preapproval/search", ("external_reference", reference(id))).await?;
        if rows.len() > 1 {
            return Err(GatewayError::Invalid);
        }
        Ok(rows.pop())
    }
    async fn agreement(&self, id: &str) -> Result<Agreement> {
        self.resource("/preapproval", id).await
    }
    async fn cancel(&self, id: &str) -> Result<Agreement> {
        if !valid_id(id) {
            return Err(GatewayError::Invalid);
        }
        let path = format!("/preapproval/{id}");
        let value = self.request(Method::PUT, &path, Some(json!({"status":"canceled"})), None, &[]).await;
        let value = match value {
            Err(GatewayError::Rejected(400)) => {
                self.request(Method::PUT, &path, Some(json!({"status":"cancelled"})), None, &[]).await?
            }
            other => other?,
        };
        serde_json::from_value(value).map_err(|_| GatewayError::Invalid)
    }
    async fn payment(&self, id: &str) -> Result<Payment> {
        let payment: Payment = self.resource("/v1/payments", id).await?;
        if payment.id.to_string() != id {
            return Err(GatewayError::Invalid);
        }
        Ok(payment)
    }
    async fn invoice(&self, id: &str) -> Result<Invoice> {
        self.resource("/authorized_payments", id).await
    }
    async fn invoices(&self, id: &str) -> Result<Vec<Invoice>> {
        if !valid_id(id) {
            return Err(GatewayError::Invalid);
        }
        self.search("/authorized_payments/search", ("preapproval_id", id.to_string())).await
    }
    async fn create_order(
        &self,
        id: Uuid,
        email: &str,
        quantity: i32,
        unit_cents: i64,
        shipping_cents: i64,
    ) -> Result<Hosted> {
        let mut items = vec![
            json!({ "id": "aule-device", "title": "Dispositivo Aule", "quantity": quantity, "currency_id": CURRENCY, "unit_price": unit_cents as f64 / 100.0 }),
        ];
        if shipping_cents > 0 {
            items.push(json!({ "id": "delivery", "title": "Envío", "quantity": 1, "currency_id": CURRENCY, "unit_price": shipping_cents as f64 / 100.0 }));
        }
        let back = format!("{}/order/pending?order={id}", self.settings.store_url);
        let body = json!({ "items": items, "payer": { "email": email }, "external_reference": reference(id), "back_urls": { "success": back, "pending": back, "failure": back }, "auto_return": "approved", "notification_url": format!("{}/api/payments/webhook", self.settings.public_url), "statement_descriptor": "AULE" });
        let value = self.request(Method::POST, "/checkout/preferences", Some(body), Some(id), &[]).await?;
        let key = if self.settings.live_mode { "init_point" } else { "sandbox_init_point" };
        let id = value["id"].as_str().filter(|id| valid_id(id)).ok_or(GatewayError::Invalid)?.to_string();
        let url =
            value[key].as_str().filter(|url| safe_checkout(url)).ok_or(GatewayError::Invalid)?.to_string();
        Ok(Hosted { id, url })
    }
    async fn find_order(&self, id: Uuid) -> Result<Option<Hosted>> {
        let value = self
            .request(
                Method::GET,
                "/checkout/preferences/search",
                None,
                None,
                &[("external_reference", reference(id)), ("limit", "2".into())],
            )
            .await?;
        let rows = value["elements"].as_array().ok_or(GatewayError::Invalid)?;
        if rows.is_empty() {
            return Ok(None);
        }
        if rows.len() != 1 {
            return Err(GatewayError::Invalid);
        }
        let key = rows[0]["id"].as_str().ok_or(GatewayError::Invalid)?;
        let pref: Value = self.resource("/checkout/preferences", key).await?;
        if pref["external_reference"] != reference(id)
            || pref["collector_id"].as_u64() != Some(self.settings.collector_id)
        {
            return Err(GatewayError::Invalid);
        }
        let field = if self.settings.live_mode { "init_point" } else { "sandbox_init_point" };
        let url =
            pref[field].as_str().filter(|url| safe_checkout(url)).ok_or(GatewayError::Invalid)?.to_string();
        Ok(Some(Hosted { id: key.into(), url }))
    }
    async fn order_payments(&self, id: Uuid) -> Result<Vec<Payment>> {
        self.search("/v1/payments/search", ("external_reference", reference(id))).await
    }
}
