# Changelog

## 0.0.1 (2026-11-24)

First numbered version. Everything before it is in the git history.

* A voice tutor on LiveKit Agents with two safety gates, content moderation and physical safety, that fail closed: a child's session does not start without both.
* A platform in Rust with families, children and consent, sign-in, plans, sessions, a learner model, memory between sessions and a supervisor that plans and reviews each session. Its device routes have only been tried by tests that play the device.
* A session engine that runs a session on a topic its bank covers, its stages, exercises, hints and report, without a language model.
* The playground, where a family signs in, sets up a student and talks to the tutor, and where the team has its panel.
* One compose file for all of it, a database backup every six hours and a weekly restore check.
