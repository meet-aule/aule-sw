//! Runs the production arithmetic module without a server or database.
#![allow(dead_code)]
#[path = "../../../../../platform/src/exercise.rs"]
mod exercise;

use std::io::{self, BufRead};
use serde_json::{Value, json};

fn main() {
    for line in io::stdin().lock().lines() {
        let result = line.ok().and_then(|line| serde_json::from_str::<Value>(&line).ok())
            .and_then(|v| {
                let expression = v["expression"].as_str()?;
                let ex = exercise::Exercise::parse(expression)?;
                let said = v["said"].as_str().unwrap_or("");
                let form = serde_json::from_value(v["form"].clone()).unwrap_or_default();
                let reading = exercise::check(&ex, form, said);
                Some(json!({"answer": ex.answer.to_string(), "verdict": reading.verdict,
                    "misconception": reading.misconception,
                    "gives_away": ex.is_given_away_by(expression, said)}))
            });
        println!("{}", result.unwrap_or(json!({"unsupported": true})));
    }
}
