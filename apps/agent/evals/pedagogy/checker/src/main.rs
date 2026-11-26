//! Runs the production arithmetic module without a server or database.
#![allow(dead_code)]
#[path = "../../../../../platform/src/exercise.rs"]
mod exercise;

use std::io::{self, BufRead};
use serde_json::{Value, json};

fn main() {
    for line in io::stdin().lock().lines() {
        let result = line.ok().and_then(|line| serde_json::from_str::<Value>(&line).ok())
            .and_then(|v| read(&v));
        println!("{}", result.unwrap_or(json!({"unsupported": true})));
    }
}

/// One request, read as the platform's /answers reads it (practice.rs): a wrong
/// number said about another calculation, or in a question of the student's
/// own, is not an answer and does not count as a try.
fn read(v: &Value) -> Option<Value> {
    let expression = v["expression"].as_str()?;
    let ex = exercise::Exercise::parse(expression)?;
    let said = v["said"].as_str().unwrap_or("");
    let form = serde_json::from_value(v["form"].clone()).unwrap_or_default();
    let mut reading = exercise::check(&ex, form, said);
    if reading.verdict == exercise::Verdict::Incorrect && exercise::is_about_something_else(expression, said) {
        reading = exercise::Reading { read: None, verdict: exercise::Verdict::NotAnAnswer, misconception: None };
    }
    Some(json!({"answer": ex.answer.to_string(), "verdict": reading.verdict,
        "misconception": reading.misconception,
        "gives_away": ex.is_given_away_by(expression, said)}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verdict(expression: &str, said: &str) -> Value {
        read(&json!({"expression": expression, "said": said})).unwrap()["verdict"].clone()
    }

    #[test]
    fn another_calculation_is_not_an_answer() {
        assert_eq!(verdict("3 x 4", "siete por ocho es 54"), json!("not_an_answer"));
        assert_eq!(verdict("3 x 4", "Seven times eight is 54"), json!("not_an_answer"));
        // About this exercise, or a bare number: an answer, right or wrong.
        assert_eq!(verdict("3 x 4", "tres por cuatro es 11"), json!("incorrect"));
        assert_eq!(verdict("25 + 3 * 2", "56"), json!("incorrect"));
        assert_eq!(verdict("25 + 3 * 2", "Me salió 31"), json!("correct"));
        assert_eq!(verdict("25 + 3 * 2", "no sé"), json!("dont_know"));
        assert_eq!(read(&json!({"expression": "el perímetro", "said": "4"})), None);
    }
}
