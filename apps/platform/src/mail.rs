//! Sending email: sign-in codes and notices to guardians.

use async_trait::async_trait;
use lettre::message::header::ContentType;
use lettre::message::header::{HeaderName, HeaderValue};
use lettre::message::{Mailbox, MultiPart, SinglePart};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::config::Mail;

#[derive(Debug, thiserror::Error)]
#[error("the email could not be sent: {0}")]
pub struct MailError(pub String);

#[async_trait]
pub trait Mailer: Send + Sync {
    async fn send(&self, to: &str, subject: &str, body: &str) -> Result<(), MailError>;

    async fn send_notice(
        &self,
        to: &str,
        subject: &str,
        body: &str,
        links: &NoticeLinks,
    ) -> Result<(), MailError> {
        let text = format!("{body}\n\n{}: {}", links.unsubscribe_label(), links.unsubscribe);
        self.send(to, subject, &text).await
    }
}

pub struct SmtpMailer {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
}

impl SmtpMailer {
    pub fn new(settings: &Mail) -> Result<Self, MailError> {
        let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(&settings.smtp_url)
            // The URL holds the password, so the error is not passed on.
            .map_err(|_| MailError("AULE_SMTP_URL is not a usable SMTP URL".into()))?
            .build();
        let from = settings.from.parse().map_err(|_| MailError("AULE_MAIL_FROM is not an address".into()))?;
        Ok(Self { transport, from })
    }
}

/// Links are built by the platform, never taken from a child's words.
pub struct NoticeLinks {
    pub language: String,
    pub app: String,
    pub unsubscribe: String,
}

impl NoticeLinks {
    fn unsubscribe_label(&self) -> &str {
        if self.language == "en" {
            "Unsubscribe from email notices"
        } else {
            "Dejar de recibir avisos por correo"
        }
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Table layout and inline styles work without scripts, remote fonts or tracking pixels.
pub fn html(subject: &str, body: &str, links: Option<&NoticeLinks>) -> String {
    let subject = escape(subject);
    let paragraphs = body
        .split("\n\n")
        .map(|text| {
            format!(
                "<p style=\"margin:0 0 20px;font:17px/1.65 Arial,sans-serif;color:#33352f\">{}</p>",
                escape(text).replace('\n', "<br>")
            )
        })
        .collect::<String>();
    let (language, actions) = links.map_or(("und", String::new()), |links| {
        let label = if links.language == "en" { "Open Aule" } else { "Abrir Aule" };
        let note = if links.language == "en" { "Email notices are optional. Your account and sign-in codes stay active." } else { "Los avisos por correo son opcionales. Tu cuenta y los códigos de acceso siguen activos." };
        (if links.language == "en" { "en" } else { "es" }, format!(r#"<p style="margin:28px 0"><a href="{}" style="display:inline-block;background:#242521;color:#f5f4ed;padding:15px 24px;border-radius:10px;text-decoration:none;font:16px Arial,sans-serif">{label}</a></p><hr style="border:0;border-top:1px solid #deddd5;margin:32px 0"><p style="font:13px/1.6 Arial,sans-serif;color:#5d6058">{note}</p><p><a href="{}" style="display:inline-block;border:1px solid #77796e;border-radius:8px;padding:12px 16px;color:#33352f;font:14px Arial,sans-serif;text-decoration:underline">{}</a></p>"#, escape(&links.app), escape(&links.unsubscribe), links.unsubscribe_label()))
    });
    format!(
        r#"<!doctype html><html lang="{language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{subject}</title></head><body style="margin:0;background:#f5f4ed"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f4ed"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px"><tr><td style="padding:24px 20px;font:bold 34px Georgia,serif;color:#242521">Aule</td></tr><tr><td style="background:#fffef9;border-radius:16px;padding:32px 24px"><h1 style="margin:0 0 24px;font:30px/1.2 Georgia,serif;color:#242521">{subject}</h1>{paragraphs}{actions}</td></tr><tr><td style="padding:24px;font:12px Arial,sans-serif;color:#606258">Aule</td></tr></table></td></tr></table></body></html>"#
    )
}

fn message(
    from: &Mailbox,
    to: &str,
    subject: &str,
    body: &str,
    links: Option<&NoticeLinks>,
) -> Result<Message, MailError> {
    let mut builder = Message::builder()
        .from(from.clone())
        .to(to.parse().map_err(|_| MailError("the recipient is not an address".into()))?)
        .subject(subject);
    let text = if let Some(links) = links {
        builder = builder
            .raw_header(HeaderValue::new(
                HeaderName::new_from_ascii_str("List-Unsubscribe"),
                format!("<{}>", links.unsubscribe),
            ))
            .raw_header(HeaderValue::new(
                HeaderName::new_from_ascii_str("List-Unsubscribe-Post"),
                "List-Unsubscribe=One-Click".into(),
            ));
        format!("{body}\n\nAule: {}\n{}: {}", links.app, links.unsubscribe_label(), links.unsubscribe)
    } else {
        body.to_string()
    };
    builder
        .multipart(
            MultiPart::alternative()
                .singlepart(SinglePart::builder().header(ContentType::TEXT_PLAIN).body(text))
                .singlepart(
                    SinglePart::builder().header(ContentType::TEXT_HTML).body(html(subject, body, links)),
                ),
        )
        .map_err(|error| MailError(error.to_string()))
}

#[async_trait]
impl Mailer for SmtpMailer {
    async fn send(&self, to: &str, subject: &str, body: &str) -> Result<(), MailError> {
        let message = message(&self.from, to, subject, body, None)?;
        self.transport.send(message).await.map_err(|error| MailError(error.to_string()))?;
        Ok(())
    }

    async fn send_notice(
        &self,
        to: &str,
        subject: &str,
        body: &str,
        links: &NoticeLinks,
    ) -> Result<(), MailError> {
        let message = message(&self.from, to, subject, body, Some(links))?;
        self.transport.send(message).await.map_err(|error| MailError(error.to_string()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mail_says_its_body_is_utf8() {
        let from: Mailbox = "Aule <hola@meetaule.com>".parse().unwrap();
        let sent = message(&from, "familia@example.com", "Tu código", "Tu código es 123456", None).unwrap();
        let raw = String::from_utf8(sent.formatted()).unwrap().to_lowercase();
        assert!(raw.contains("content-type: text/plain; charset=utf-8"), "{raw}");
    }
    #[test]
    fn html_escapes_child_text_and_only_notices_offer_unsubscribe() {
        let from: Mailbox = "Aule <admin@example.org>".parse().unwrap();
        let text = "A <script>alert(1)</script> & an answer.\n\nNext paragraph.";
        let safe = html("<img src=x>", text, None);
        assert!(!safe.contains("<script>"));
        assert!(!safe.contains("<img"));
        assert!(safe.contains("&lt;script&gt;"));
        let code = message(&from, "family@example.org", "Sign in", "123456", None).unwrap();
        let raw = String::from_utf8(code.formatted()).unwrap();
        assert!(raw.contains("multipart/alternative"));
        assert!(raw.contains("text/plain; charset=utf-8"));
        assert!(raw.contains("text/html; charset=utf-8"));
        assert!(!raw.contains("List-Unsubscribe"));
        let links = NoticeLinks {
            language: "en".into(),
            app: "https://example.org/session/".into(),
            unsubscribe: "https://example.org/session/unsubscribe?token=test".into(),
        };
        let notice = message(&from, "family@example.org", "Session", text, Some(&links)).unwrap();
        let raw = String::from_utf8(notice.formatted()).unwrap();
        assert!(raw.contains("List-Unsubscribe: <https://example.org/session/unsubscribe?token=test>"));
        assert!(raw.contains("List-Unsubscribe-Post: List-Unsubscribe=One-Click"));
        assert!(html("Session", text, Some(&links)).contains("<html lang=\"en\">"));
    }
}
