//! What Aule's team reads about the families, and never what was said. The
//! team's lists run newest first and are read a page at a time: a page ends
//! with a cursor, and the next one starts after it.

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

/// The most characters a search may have.
const MAX_SEARCH_CHARS: usize = 100;

/// Where a list goes on: the creation time and the id of the last row the
/// page before held, written `<microseconds since 1970>_<id>`. Postgres keeps
/// microseconds, so the time comes back exactly, and the id settles a tie.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cursor {
    pub at: DateTime<Utc>,
    pub id: Uuid,
}

impl Cursor {
    pub fn write(at: DateTime<Utc>, id: Uuid) -> String {
        format!("{}_{}", at.timestamp_micros(), id.hyphenated())
    }

    /// A cursor as `write` makes it, and nothing else.
    pub fn read(text: &str) -> ApiResult<Self> {
        let refused = || ApiError::bad_request("before is not a cursor");
        let (micros, id) = text.split_once('_').ok_or_else(refused)?;
        if micros.is_empty() || micros.len() > 18 || !micros.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(refused());
        }
        let at = micros.parse().ok().and_then(DateTime::from_timestamp_micros).ok_or_else(refused)?;
        let id = Uuid::try_parse(id).map_err(|_| refused())?;
        // Only the form `write` gives: hyphenated and lower case.
        if id.hyphenated().to_string() != text[micros.len() + 1..] {
            return Err(refused());
        }
        Ok(Self { at, id })
    }
}

/// A query's value, with an empty one taken as not given: a form sends its
/// empty fields too.
pub fn given(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|value| !value.is_empty())
}

/// How many rows a page holds: `default` when not asked for, otherwise the
/// number asked for, kept from 1 to `most`.
pub fn page_size(asked: Option<&str>, default: i64, most: i64) -> ApiResult<i64> {
    let Some(asked) = asked else { return Ok(default) };
    let asked: i64 = asked.parse().map_err(|_| ApiError::bad_request("limit must be a whole number"))?;
    Ok(asked.clamp(1, most))
}

/// What the team typed, as a pattern for `ilike` that finds it anywhere, with
/// `\`, `%` and `_` standing for themselves.
pub fn search_pattern(typed: &str) -> ApiResult<String> {
    if typed.chars().count() > MAX_SEARCH_CHARS || typed.chars().any(char::is_control) {
        return Err(ApiError::bad_request(format!(
            "q must have at most {MAX_SEARCH_CHARS} characters, on one line"
        )));
    }
    let mut pattern = String::with_capacity(typed.len() + 2);
    pattern.push('%');
    for c in typed.chars() {
        if matches!(c, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    Ok(pattern)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_reads_back_what_it_wrote() {
        let at = "2026-11-25T15:04:05.123456Z".parse::<DateTime<Utc>>().unwrap();
        let id = Uuid::parse_str("01a1f5f4-ede7-7028-a524-9d8e2f36b92d").unwrap();
        let written = Cursor::write(at, id);
        assert_eq!(written, "1795619045123456_01a1f5f4-ede7-7028-a524-9d8e2f36b92d");
        assert_eq!(Cursor::read(&written).unwrap(), Cursor { at, id });
    }

    #[test]
    fn anything_else_is_no_cursor() {
        for text in [
            "",
            "_",
            "1795619045123456",
            "1795619045123456_",
            "_01a1f5f4-ede7-7028-a524-9d8e2f36b92d",
            "-1_01a1f5f4-ede7-7028-a524-9d8e2f36b92d",
            "+1_01a1f5f4-ede7-7028-a524-9d8e2f36b92d",
            " 1_01a1f5f4-ede7-7028-a524-9d8e2f36b92d",
            "1.5_01a1f5f4-ede7-7028-a524-9d8e2f36b92d",
            "9999999999999999999_01a1f5f4-ede7-7028-a524-9d8e2f36b92d",
            "1_01A1F5F4-EDE7-7028-A524-9D8E2F36B92D",
            "1_01a1f5f4ede77028a5249d8e2f36b92d",
            "1_{01a1f5f4-ede7-7028-a524-9d8e2f36b92d}",
            "1_01a1f5f4-ede7-7028-a524-9d8e2f36b92d_2",
            "1_01a1f5f4-ede7-7028-a524-9d8e2f36b92",
        ] {
            assert!(Cursor::read(text).is_err(), "{text:?}");
        }
    }

    #[test]
    fn a_page_holds_what_was_asked_within_its_bounds() {
        assert_eq!(page_size(None, 20, 50).unwrap(), 20);
        assert_eq!(page_size(Some("7"), 20, 50).unwrap(), 7);
        assert_eq!(page_size(Some("0"), 20, 50).unwrap(), 1);
        assert_eq!(page_size(Some("-3"), 20, 50).unwrap(), 1);
        assert_eq!(page_size(Some("500"), 20, 50).unwrap(), 50);
        for bad in ["x", "1.5", "1e3", "99999999999999999999"] {
            assert!(page_size(Some(bad), 20, 50).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_search_finds_the_text_as_it_was_typed() {
        assert_eq!(search_pattern("ana@").unwrap(), "%ana@%");
        // The characters that mean something to `like` mean only themselves.
        assert_eq!(search_pattern("a_b").unwrap(), r"%a\_b%");
        assert_eq!(search_pattern("100%").unwrap(), r"%100\%%");
        assert_eq!(search_pattern(r"a\b").unwrap(), r"%a\\b%");
        assert!(search_pattern(&"a".repeat(100)).is_ok());
        assert!(search_pattern(&"a".repeat(101)).is_err());
        assert!(search_pattern("ana\nluis").is_err());
        assert!(search_pattern("ana\u{0}").is_err());
    }

    #[test]
    fn an_empty_value_is_not_given() {
        assert_eq!(given(&None), None);
        assert_eq!(given(&Some(String::new())), None);
        assert_eq!(given(&Some("  ".into())), None);
        assert_eq!(given(&Some(" cesar ".into())), Some("cesar"));
    }
}
