//! What the tutor remembers about a child between sessions.
//!
//! A memory is a short statement derived from a session ("multiplies by
//! counting on fingers", "loves football examples"), never the transcript. It
//! is stored with an embedding so the supervisor can ask for the memories
//! closest to what the child is saying now.
//!
//! The embedding model is whatever speaks the OpenAI embeddings API at the
//! configured URL. Pointing it at a model you run yourself keeps a child's
//! memories from leaving your server. Without one, memories are still stored
//! and recalled by date.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sea_orm::ActiveValue::Set;
use sea_orm::prelude::PgVector;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, DbBackend, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::config::Embeddings;
use crate::entity::{child, memory, session};
use crate::families::current_consent;

/// The size of `memories.embedding`. Changing the model to one of another size
/// needs a migration and re-embedding.
pub const DIMENSIONS: usize = 1024;
pub const KINDS: [&str; 5] = ["fact", "preference", "struggle", "success", "summary"];
pub const MAX_CONTENT_CHARS: usize = 600;
/// Cosine distance under which a new memory repeats one the child already has.
const SAME_MEMORY_DISTANCE: f64 = 0.08;

#[derive(Debug, thiserror::Error)]
pub enum MemoryError {
    #[error("the embedding model could not be reached: {0}")]
    Transport(String),
    #[error("the embedding model answered with status {0}")]
    Status(u16),
    #[error("the embedding model returned {0}")]
    Shape(String),
    #[error(transparent)]
    Database(#[from] sea_orm::DbErr),
}

#[async_trait]
pub trait Embedder: Send + Sync {
    async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, MemoryError>;
}

pub struct HttpEmbedder {
    client: reqwest::Client,
    settings: Embeddings,
}

impl HttpEmbedder {
    pub fn new(settings: Embeddings) -> Self {
        Self { client: reqwest::Client::new(), settings }
    }
}

pub fn parse_embeddings(body: &Value, expected: usize) -> Result<Vec<Vec<f32>>, MemoryError> {
    let data = body["data"].as_array().ok_or_else(|| MemoryError::Shape("no data array".into()))?;
    if data.len() != expected {
        return Err(MemoryError::Shape(format!("{} embeddings for {expected} texts", data.len())));
    }
    data.iter()
        .map(|item| {
            let vector: Vec<f32> = serde_json::from_value(item["embedding"].clone())
                .map_err(|_| MemoryError::Shape("an embedding that is not a list of numbers".into()))?;
            if vector.len() != DIMENSIONS || vector.iter().any(|value| !value.is_finite()) {
                return Err(MemoryError::Shape(format!(
                    "an embedding of {} dimensions, not {DIMENSIONS}",
                    vector.len()
                )));
            }
            Ok(vector)
        })
        .collect()
}

#[async_trait]
impl Embedder for HttpEmbedder {
    async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, MemoryError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let mut request = self
            .client
            .post(format!("{}/embeddings", self.settings.url))
            .timeout(std::time::Duration::from_secs(20))
            .json(&json!({ "model": self.settings.model, "input": texts }));
        if let Some(api_key) = &self.settings.api_key {
            request = request.bearer_auth(api_key);
        }
        let response =
            request.send().await.map_err(|error| MemoryError::Transport(error.without_url().to_string()))?;
        if !response.status().is_success() {
            return Err(MemoryError::Status(response.status().as_u16()));
        }
        let body: Value = response.json().await.map_err(|error| MemoryError::Transport(error.to_string()))?;
        parse_embeddings(&body, texts.len())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Memory {
    pub id: Uuid,
    pub kind: String,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

impl From<memory::Model> for Memory {
    fn from(row: memory::Model) -> Self {
        Self { id: row.id, kind: row.kind, content: row.content, created_at: row.created_at }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct NewMemory {
    pub kind: String,
    pub content: String,
}

impl NewMemory {
    /// Trimmed and cut to size; `None` if nothing usable is left.
    pub fn cleaned(&self) -> Option<Self> {
        let content: String = self.content.trim().chars().take(MAX_CONTENT_CHARS).collect();
        (KINDS.contains(&self.kind.as_str()) && !content.is_empty())
            .then(|| Self { kind: self.kind.clone(), content })
    }
}

async fn storage_allowed(
    db: &impl ConnectionTrait,
    child_id: Uuid,
    session_id: Option<Uuid>,
) -> Result<bool, sea_orm::DbErr> {
    if !current_consent(db, child_id).await?["memory"] {
        return Ok(false);
    }
    match session_id {
        Some(session_id) => Ok(session::Entity::find_by_id(session_id)
            .filter(session::Column::ChildId.eq(child_id))
            .select_only()
            .column(session::Column::UseMemory)
            .into_tuple::<bool>()
            .one(db)
            .await?
            .unwrap_or(false)),
        None => Ok(true),
    }
}

/// Stores the memories of a session and returns how many were new. A memory
/// that repeats one the child already has is skipped.
pub async fn remember(
    db: &DatabaseConnection,
    embedder: Option<&dyn Embedder>,
    child_id: Uuid,
    session_id: Option<Uuid>,
    memories: &[NewMemory],
) -> Result<usize, MemoryError> {
    let memories: Vec<NewMemory> = memories.iter().filter_map(NewMemory::cleaned).collect();
    if memories.is_empty() {
        return Ok(0);
    }
    if !storage_allowed(db, child_id, session_id).await? {
        return Ok(0);
    }
    let embeddings = match embedder {
        Some(embedder) => {
            let texts: Vec<String> = memories.iter().map(|memory| memory.content.clone()).collect();
            Some(embedder.embed(&texts).await?)
        }
        None => None,
    };

    // Never hold the child lock while waiting for the embedding provider.
    // Recheck after it returns, serialized with consent changes.
    let txn = db.begin().await?;
    let child = child::Entity::find_by_id(child_id)
        .select_only()
        .column(child::Column::Id)
        .lock_exclusive()
        .into_tuple::<Uuid>()
        .one(&txn)
        .await?;
    if child.is_none() || !storage_allowed(&txn, child_id, session_id).await? {
        return Ok(0);
    }
    let mut stored = 0;
    for (index, new) in memories.iter().enumerate() {
        let vector = embeddings.as_ref().map(|all| PgVector::from(all[index].clone()));
        if let Some(vector) = &vector {
            let nearest = txn
                .query_one_raw(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "select min(embedding <=> $2) as nearest from memories where child_id = $1 and embedding is not null",
                    [child_id.into(), vector.clone().into()],
                ))
                .await?
                .map(|row| row.try_get::<Option<f64>>("", "nearest"))
                .transpose()?
                .flatten();
            if nearest.is_some_and(|distance| distance < SAME_MEMORY_DISTANCE) {
                continue;
            }
        }
        memory::Entity::insert(memory::ActiveModel {
            id: Set(Uuid::now_v7()),
            child_id: Set(child_id),
            session_id: Set(session_id),
            kind: Set(new.kind.clone()),
            content: Set(new.content.clone()),
            embedding: Set(vector),
            ..Default::default()
        })
        .exec_without_returning(&txn)
        .await?;
        stored += 1;
    }
    txn.commit().await?;
    Ok(stored)
}

/// The memories closest in meaning to `query`, or the latest ones when there
/// is no embedding model or it fails: recall must not stop a session.
pub async fn recall(
    db: &DatabaseConnection,
    embedder: Option<&dyn Embedder>,
    child_id: Uuid,
    query: &str,
    limit: i64,
) -> Result<Vec<Memory>, sea_orm::DbErr> {
    if let (Some(embedder), false) = (embedder, query.trim().is_empty()) {
        match embedder.embed(&[query.to_string()]).await {
            Ok(vectors) => {
                let closest = memory::Entity::find()
                    .from_raw_sql(Statement::from_sql_and_values(
                        DbBackend::Postgres,
                        "select * from memories where child_id = $1 and embedding is not null
                         order by embedding <=> $2 limit $3",
                        [child_id.into(), PgVector::from(vectors[0].clone()).into(), limit.into()],
                    ))
                    .all(db)
                    .await?;
                return Ok(closest.into_iter().map(Memory::from).collect());
            }
            Err(error) => tracing::warn!(%error, "recall fell back to the latest memories"),
        }
    }
    latest(db, child_id, limit).await
}

pub async fn latest(
    db: &DatabaseConnection,
    child_id: Uuid,
    limit: i64,
) -> Result<Vec<Memory>, sea_orm::DbErr> {
    let rows = memory::Entity::find()
        .filter(memory::Column::ChildId.eq(child_id))
        .order_by_desc(memory::Column::CreatedAt)
        .limit(limit.max(0) as u64)
        .all(db)
        .await?;
    Ok(rows.into_iter().map(Memory::from).collect())
}

pub async fn forget(
    db: &DatabaseConnection,
    child_id: Uuid,
    memory_id: Uuid,
) -> Result<bool, sea_orm::DbErr> {
    let deleted = memory::Entity::delete_many()
        .filter(memory::Column::Id.eq(memory_id))
        .filter(memory::Column::ChildId.eq(child_id))
        .exec(db)
        .await?;
    if deleted.rows_affected == 0 {
        return Ok(false);
    }
    // The plan written ahead for the next session may have it in it. One
    // being written at this moment is not found here, and is never used: its
    // key names the memories it was made from, and they are no longer these.
    crate::ahead::forget(db, child_id).await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeddings_of_the_wrong_shape_are_refused() {
        let good: Vec<f32> = vec![0.1; DIMENSIONS];
        let body = json!({ "data": [{ "embedding": good }] });
        assert_eq!(parse_embeddings(&body, 1).unwrap().len(), 1);

        assert!(parse_embeddings(&body, 2).is_err());
        assert!(parse_embeddings(&json!({ "data": [{ "embedding": [0.1, 0.2] }] }), 1).is_err());
        assert!(parse_embeddings(&json!({ "data": [{ "embedding": "x" }] }), 1).is_err());
        assert!(parse_embeddings(&json!({}), 1).is_err());
    }

    #[test]
    fn a_memory_is_cleaned_before_it_is_stored() {
        let memory = NewMemory { kind: "fact".into(), content: format!("  {}  ", "a".repeat(700)) };
        assert_eq!(memory.cleaned().unwrap().content.chars().count(), MAX_CONTENT_CHARS);

        assert!(NewMemory { kind: "gossip".into(), content: "x".into() }.cleaned().is_none());
        assert!(NewMemory { kind: "fact".into(), content: "   ".into() }.cleaned().is_none());
    }
}
