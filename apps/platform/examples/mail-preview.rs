//! Render a synthetic notice without connecting to SMTP: cargo run --example mail-preview.
use aule_platform::mail::{NoticeLinks, html};

fn main() {
    let english = std::env::args().nth(1).as_deref() == Some("en");
    let links = NoticeLinks {
        language: if english { "en" } else { "es" }.into(),
        app: "https://example.org/session/".into(),
        unsubscribe: "https://example.org/session/unsubscribe?token=preview".into(),
    };
    let (title, body) = if english {
        (
            "Today's session",
            "We practised adding fractions with different denominators.\n\nNext time: try another example, one step at a time.",
        )
    } else {
        (
            "La sesión de hoy",
            "Practicamos la suma de fracciones con denominadores distintos.\n\nPara la próxima: probar otro ejemplo, paso a paso.",
        )
    };
    println!("{}", html(title, body, Some(&links)));
}
