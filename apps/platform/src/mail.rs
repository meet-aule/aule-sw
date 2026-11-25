//! Sending email: sign-in codes and notices to guardians.

use async_trait::async_trait;
use lettre::message::Mailbox;
use lettre::message::header::ContentType;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::config::Mail;

#[derive(Debug, thiserror::Error)]
#[error("the email could not be sent: {0}")]
pub struct MailError(pub String);

#[async_trait]
pub trait Mailer: Send + Sync {
    async fn send(&self, to: &str, subject: &str, body: &str) -> Result<(), MailError>;
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

/// The message as it is sent. Its body is UTF-8 and says so: with no charset
/// declared a mail reader may take it for ASCII and garble the «ó» of «código».
fn message(from: &Mailbox, to: &str, subject: &str, body: &str) -> Result<Message, MailError> {
    Message::builder()
        .from(from.clone())
        .to(to.parse().map_err(|_| MailError("the recipient is not an address".into()))?)
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(body.to_string())
        .map_err(|error| MailError(error.to_string()))
}

#[async_trait]
impl Mailer for SmtpMailer {
    async fn send(&self, to: &str, subject: &str, body: &str) -> Result<(), MailError> {
        let message = message(&self.from, to, subject, body)?;
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
        let sent = message(&from, "familia@example.com", "Tu código", "Tu código es 123456").unwrap();
        let raw = String::from_utf8(sent.formatted()).unwrap().to_lowercase();
        assert!(raw.contains("content-type: text/plain; charset=utf-8"), "{raw}");
    }
}
