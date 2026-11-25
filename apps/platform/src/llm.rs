//! The language model behind the supervisor. Every call asks for one JSON
//! object that follows a schema, so the answer can be checked before it is used.

use std::time::Duration;

use async_trait::async_trait;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::config::Supervisor;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    /// Plans and reviews, outside the conversation.
    Deep,
    /// Guidance while a session is running.
    Live,
}

/// How hard the model thinks before it answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effort {
    /// When someone is waiting: guidance during a session, the plan before it.
    Low,
    /// When nobody is: the review after a session.
    Medium,
}

pub struct Request<'a> {
    pub tier: Tier,
    pub effort: Effort,
    pub system: &'a str,
    pub user: &'a str,
    /// What is being asked for, to tell requests apart in logs and tests.
    pub answer: &'a str,
    /// JSON Schema of the object to return. Every object in it must set
    /// `additionalProperties: false`, and numeric or length limits are not
    /// supported: check those after parsing.
    pub schema: &'a Value,
    pub max_tokens: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("the language model could not be reached: {0}")]
    Transport(String),
    #[error("the language model answered with status {0}{1}")]
    Status(u16, String),
    #[error("the language model did not return the requested object")]
    NoAnswer,
}

#[async_trait]
pub trait Llm: Send + Sync {
    async fn answer(&self, request: Request<'_>) -> Result<Value, LlmError>;
}

/// Claude through the Anthropic Messages API, with structured outputs: the
/// schema goes in `output_config.format` and the answer comes back as JSON
/// text. (Forcing a tool call, the older way to get an object, is refused by
/// the current models.)
pub struct Anthropic {
    client: reqwest::Client,
    settings: Supervisor,
    base_url: String,
    usage: Option<DatabaseConnection>,
}

tokio::task_local! {
    /// The session a model call is made for. Set around a call with
    /// `SESSION.scope(id, ...)`; its usage is then added to that session's
    /// counts in `session_model_usage`.
    pub static SESSION: Uuid;
}

impl Anthropic {
    pub fn new(settings: Supervisor) -> Self {
        Self {
            client: reqwest::Client::new(),
            settings,
            base_url: "https://api.anthropic.com".into(),
            usage: None,
        }
    }

    /// Adds each call's usage to its session's counts in this database.
    pub fn with_usage(mut self, db: DatabaseConnection) -> Self {
        self.usage = Some(db);
        self
    }

    async fn record(&self, model: &str, tokens: impl Fn(&str) -> u64) {
        let (Some(db), Ok(session)) = (&self.usage, SESSION.try_with(|id| *id)) else { return };
        let count = |field: &str| i64::try_from(tokens(field)).unwrap_or(i64::MAX);
        let recorded = db
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "insert into session_model_usage
               (session_id, model, calls, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens)
             values ($1, $2, 1, $3, $4, $5, $6)
             on conflict (session_id, model) do update set
               calls = session_model_usage.calls + 1,
               input_tokens = session_model_usage.input_tokens + excluded.input_tokens,
               cache_read_tokens = session_model_usage.cache_read_tokens + excluded.cache_read_tokens,
               cache_write_tokens = session_model_usage.cache_write_tokens + excluded.cache_write_tokens,
               output_tokens = session_model_usage.output_tokens + excluded.output_tokens",
                [
                    session.into(),
                    model.into(),
                    count("input_tokens").into(),
                    count("cache_read_input_tokens").into(),
                    count("cache_creation_input_tokens").into(),
                    count("output_tokens").into(),
                ],
            ))
            .await;
        if let Err(error) = recorded {
            // A count missed is a smaller cost estimate, never a failed answer.
            tracing::warn!(%session, %error, "model usage not recorded");
        }
    }
}

pub fn anthropic_body(model: &str, request: &Request<'_>) -> Value {
    json!({
        "model": model,
        "max_tokens": request.max_tokens,
        "system": request.system,
        "messages": [{ "role": "user", "content": request.user }],
        "output_config": {
            "effort": match request.effort {
                Effort::Low => "low",
                Effort::Medium => "medium",
            },
            "format": { "type": "json_schema", "schema": request.schema },
        },
    })
}

/// The object in the response, if the model finished and wrote one. A reply
/// that was cut short or declined has no usable answer.
pub fn anthropic_answer(response: &Value) -> Option<Value> {
    if response["stop_reason"] != "end_turn" {
        return None;
    }
    response["content"]
        .as_array()?
        .iter()
        .filter(|block| block["type"] == "text")
        .find_map(|block| serde_json::from_str::<Value>(block["text"].as_str()?).ok())
        .filter(Value::is_object)
}

#[async_trait]
impl Llm for Anthropic {
    async fn answer(&self, request: Request<'_>) -> Result<Value, LlmError> {
        let (model, timeout) = match request.tier {
            Tier::Deep => (&self.settings.model, Duration::from_secs(60)),
            Tier::Live => (&self.settings.live_model, Duration::from_secs(8)),
        };
        let response = self
            .client
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", &self.settings.api_key)
            .header("anthropic-version", "2023-06-01")
            .timeout(timeout)
            .json(&anthropic_body(model, &request))
            .send()
            .await
            // The error text of a transport failure never includes the body.
            .map_err(|error| LlmError::Transport(error.without_url().to_string()))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            // A refused request says why in its error type and message, which
            // describe the request's parameters. Nothing else of the body is kept.
            let reason = match response.json::<Value>().await {
                Ok(body) if status == 400 => format!(
                    " ({}: {})",
                    body["error"]["type"].as_str().unwrap_or("unknown"),
                    body["error"]["message"]
                        .as_str()
                        .unwrap_or_default()
                        .chars()
                        .take(160)
                        .collect::<String>()
                ),
                _ => String::new(),
            };
            return Err(LlmError::Status(status, reason));
        }
        let body: Value = response.json().await.map_err(|error| LlmError::Transport(error.to_string()))?;
        // What each call cost, so a session's cost can be added up from the
        // logs. Counts only: never what was asked or answered.
        let tokens = |field: &str| body["usage"][field].as_u64().unwrap_or(0);
        tracing::info!(
            answer = request.answer,
            model = %model,
            input_tokens = tokens("input_tokens"),
            output_tokens = tokens("output_tokens"),
            cache_read_tokens = tokens("cache_read_input_tokens"),
            cache_write_tokens = tokens("cache_creation_input_tokens"),
            "model call"
        );
        self.record(model, tokens).await;
        anthropic_answer(&body).ok_or(LlmError::NoAnswer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_asks_for_the_schema_at_the_given_effort() {
        let schema = json!({ "type": "object", "additionalProperties": false });
        let request = |tier, effort| Request {
            tier,
            effort,
            system: "be brief",
            user: "hello",
            answer: "guidance",
            schema: &schema,
            max_tokens: 200,
        };

        let live = anthropic_body("claude-haiku-5-5", &request(Tier::Live, Effort::Low));
        let deep = anthropic_body("claude-sonnet-5-5", &request(Tier::Deep, Effort::Medium));

        assert_eq!(live["output_config"]["format"], json!({ "type": "json_schema", "schema": schema }));
        assert_eq!(live["output_config"]["effort"], "low");
        assert_eq!(deep["output_config"]["effort"], "medium");
        assert_eq!(live["system"], "be brief");
        assert_eq!(deep["system"], "be brief");
        assert_eq!(live["messages"][0]["content"], "hello");
        assert!(live.get("tools").is_none() && live.get("tool_choice").is_none());
    }

    #[test]
    fn the_answer_is_the_json_text_of_a_finished_reply() {
        let reply = |stop_reason: &str, text: &str| {
            json!({ "stop_reason": stop_reason, "content": [
                { "type": "thinking", "thinking": "" },
                { "type": "text", "text": text },
            ]})
        };

        assert_eq!(
            anthropic_answer(&reply("end_turn", r#"{"text":"slow down"}"#)),
            Some(json!({ "text": "slow down" }))
        );
        assert_eq!(anthropic_answer(&reply("max_tokens", r#"{"text":"slow"#)), None);
        assert_eq!(anthropic_answer(&reply("refusal", r#"{"text":"x"}"#)), None);
        assert_eq!(anthropic_answer(&reply("end_turn", "not json")), None);
        assert_eq!(anthropic_answer(&reply("end_turn", "[1]")), None);
        assert_eq!(anthropic_answer(&json!({})), None);
    }
}
