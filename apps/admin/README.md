# Console

The team's console at https://admin.meetaule.com: how Aule is used and what it
costs, the pilot's numbers, every family with its plan and the link it came
from, found by address or name and filtered by link and plan, a page per family
with its sessions, a plan granted for free, and who is in a session now, with
one line that says whether a deploy can go. It is its own app, apart from the children's
[playground](../playground/README.md), with its own sign-in, and each team
member's passkeys for it. A child's conversation, text or audio, appears
nowhere in it.

A Node server with no framework and no build step, as the playground: Node runs
the TypeScript in `src/` as it is, and `public/` holds the pages. It has no
database. Every piece of data comes from the [platform](../platform/README.md),
asked with the signed-in team member's own token, and the platform's Staff check
decides each call.

## Routes

| Method | Path | Needs | What it does |
|---|---|---|---|
| GET, HEAD | `/` | nothing | «Resumen»: the panel moved from the playground, less its families table: the 14 days, the pilot, how many families |
| GET, HEAD | `/live` | nothing | «En vivo»: who is in a session now, and whether a deploy can go |
| GET, HEAD | `/families` | nothing | «Familias»: the families, with search and filters |
| GET, HEAD | `/family?id=<uuid>` | nothing | One family's page |
| GET, HEAD | `/passkeys` | nothing | «Passkeys»: the team member's own, to create and delete |
| GET, HEAD | `/signin` | nothing | The sign-in page |
| GET, HEAD | `/style.css`, `/admin.js`, `/live.js`, `/families.js`, `/family.js`, `/passkeys.js`, `/credential.js`, `/common.js`, `/labels.js`, `/pilot.js`, `/signin.js`, `/icon.svg`, `/fonts/serif.woff2`, `/fonts/sans.woff2` | nothing | The pages' files, fingerprinted (`src/assets.ts`, a copy of the playground's) |
| GET, HEAD | `/healthz` | nothing | `{"ok":true,"version":"0.0.1","commit":"abc123456789"}` |
| GET, HEAD | `/robots.txt` | nothing | Disallows everything |
| POST | `/api/signin/start` | the write rules | `{email}`: a code by mail, for a team address only. Always `202 {"sent":true}` |
| POST | `/api/signin/verify` | the write rules | `{email, code}`: `200 {"signed_in":true}` and the cookie, or `403 {"error":"wrong_code"}` |
| POST | `/api/signin/passkey/start` | the write rules | The platform's `POST /v1/auth/team/passkey/options`: `200 {publicKey}` for the browser's picker, the same for everyone, and the ceremony in its own cookie |
| POST | `/api/signin/passkey/finish` | the write rules, 16 KB | `{credential}`: the platform's `POST /v1/auth/team/passkey/verify`, with the ceremony from its cookie. `200 {"signed_in":true}` and the cookie, or `403 {"error":"passkey_failed"}`; the ceremony's cookie is cleared whatever the answer |
| POST | `/api/signout` | the write rules | Ends the session, with or without one: `200 {"signed_in":false}` |
| GET | `/api/build` | a session | `{admin: {version, commit}, platform: {version, commit}}` |
| GET | `/api/metrics/daily` | a session | The platform's `GET /v1/metrics/daily?days=14` |
| GET | `/api/metrics/weekly` | a session | The platform's `GET /v1/metrics/weekly?weeks=12` |
| GET | `/api/families` | a session | The platform's `GET /v1/admin/families`, with `q` (up to 100 characters, one line), `source` (a link code), `status` (`trial`, `paid`, `granted`, `none`, `team` or `free`), `before` (a cursor) and `limit` (1 to 100) |
| GET | `/api/families/{id}` | a session | The platform's `GET /v1/admin/families/{id}`: the family's page |
| GET | `/api/families/{id}/sessions`, `/api/families/{id}/notices` | a session | The platform's same routes, with `before` and `limit` (1 to 50) |
| GET | `/api/sessions/open` | a session | The platform's `GET /v1/admin/sessions/open` |
| POST | `/api/families/{id}/grant` | a session, the write rules | `{days, note?}`: the platform's `POST /v1/admin/families/{id}/grant` |
| POST | `/api/families/{id}/ungrant` | a session, the write rules | The platform's `DELETE /v1/admin/families/{id}/grant` |
| GET | `/api/passkeys` | a session | The platform's `GET /v1/admin/passkeys`: the member's own, by name and dates |
| POST | `/api/passkeys/options` | a session, the write rules | The platform's `POST /v1/admin/passkeys/options`: `200 {publicKey}` for the browser, and the ceremony in its own cookie. `409 {"error":"sign_in_again"}` when the sign-in is more than 15 minutes old; the session stays |
| POST | `/api/passkeys/create` | a session, the write rules, 16 KB | `{label, credential}`: the platform's `POST /v1/admin/passkeys`, with the ceremony from its cookie. `201 {id, label, created_at, last_used_at}`, or `409 {"error":"sign_in_again"}` when the sign-in grew too old meanwhile; the cookie is cleared whatever the answer |
| POST | `/api/passkeys/{id}/delete` | a session, the write rules | The platform's `DELETE /v1/admin/passkeys/{id}`: `200 {}`, or `404` for one that is not the member's |

Pages hold no data and are served to anyone who comes through the console's
Worker; their scripts ask the API. Any
other path is `404 {"error":"not_found"}`, and a known path asked with another
method `405` (`OPTIONS` too, with no CORS headers). An `{id}` must be a family's
UUID, `days` a whole number from 1 to 366, and a note is trimmed and cut to 500
characters. A query value is checked as the platform checks it and written
again; an empty one is left out, a bad one is `400`, and no other query or field
reaches the platform. The platform's
refusals come back in the console's words, never in the platform's: 400, 404,
`401 signed_out`, `403 not_team`, and `502 {"error":"platform"}` for anything else.

**No redirects.** No answer carries a `Location`. A page's script sends a
signed-out visitor to the fixed path `/signin`, and a sign-in goes to `/`; no
address to go back to is ever taken from a request.

## En vivo

`/live` lists who is in a session now: the family, whose name links to its page,
the child's nickname, since when, whether it is starting or running, «motor» or «libre» (the session engine
or the tutor on its own), and «web» or «aparato». Above it, one line:

- «Ninguna sesión abierta: se puede desplegar.», in ink, only when the platform
  says that no session is open;
- otherwise how many are open and «no despliegues ahora», in red. Every open
  session counts, the team's tests too: restarting the playground or the agent
  ends the sessions in progress (`infra/server/README.md`);
- a session open longer than the session's length and 50 minutes more is said
  apart, as perhaps stuck; it still counts, and the platform's housekeeping
  closes it after 3 hours.

The page asks again every 15 seconds while it is in view, at once when it comes
back into view, and on «Actualizar». A failed answer takes the line away rather
than leave an older «se puede desplegar» standing, and an answer that comes
after a newer one is dropped. A line older than 20 seconds gives way to
«Comprobando…» as soon as the next question goes, so a tab come back to after a
while, or an answer that does not come, never leaves an old «se puede
desplegar» on screen. Right before a restart, the runbook still asks the
database itself (`infra/server/README.md`). A child's conversation is in none of it: the
platform does not send it (`apps/platform`, «Aule's team»).

## Familias

`/families` lists the families, newest first, 100 at a time with «Más
familias»: the family's name, which links to its page, the link it came by, its
guardians' addresses, its children, its plan, its sessions in 7 and 30 days, its
minutes and its last session, with «Regalar plan» and «Quitar» as on the old
panel. After either, only that row asks for the family's plan again: the pages
already loaded and the filters stay as they were. The dialogs name the family
in one short line between «», whatever its name holds. A search box finds a family by any part of a guardian's address or of its
name, a list of links (with how many families came by each) and a list of plans
filter it. The filters live in the page's address (`?q=&source=&status=`, written
with `history.replaceState`), so a reload or Back keeps them; each value read
from the address is checked as the console checks it, and one that is no good
is left out. A plan is known only once the platform works it out family by
family, so a search by plan looks at 300 families at a time: its page can come
back short, and «Seguir buscando» goes on.

## Familia

`/family?id=<uuid>` shows one family: its adults (name, address, language, how
they get notices), its children (nickname, age, grade, and what each kind of
consent says now, with when and how it was given), its plan now and its trial's
dates, every plan it has had with its days, its note and who granted it
(«operador» for the operator's token), its sessions (how many started and the
latest, then date, child, length, how it ended, «motor» or «libre», «web» or
«aparato», 20 at a time with «Más sesiones») and the notices it was sent (kind,
date, child, read, mailed, pushed, with «Más avisos»). «Regalar plan» and
«Quitar» work as on «Familias». An address that names no family's id is told so
and asks nothing; a family the platform no longer has is told so too. What a
child said, a session's review and a notice's words are not there: the platform
does not send them.

## Passkeys

`/passkeys` lists the signed-in team member's own passkeys: the name they gave
it, when it was made and when it was last used, with «Borrar» on each, which
asks first and names the passkey in one short line. «Crear passkey» takes a
name (1 to 60 characters, one line), then asks the console for the options,
opens the browser's own dialog (fingerprint, face or PIN), and sends the
passkey back. The page uses the browser's own WebAuthn JSON methods
(`PublicKeyCredential.parseCreationOptionsFromJSON` and the credential's
`toJSON`): no library and no change to the CSP. Some password managers hand
the page a credential whose `toJSON` fails; `public/credential.js` then writes
the same fields by hand, and a credential it cannot read either is told as the
password manager's failure. A browser without the parser is told it cannot,
and the page offers nothing else. At 10 passkeys, the most there can be, the
button is off.

- **The platform decides.** It checks every passkey with webauthn-rs and keeps
  only its public half (`apps/platform`, «Aule's team»), and mails the member
  about every passkey added. Adding one needs a sign-in from the last 15
  minutes, when it starts and when it is kept: an older session is told to
  sign in again, and stays. The page says so before anyone tries. Deleting one
  needs a session only, and ends the sessions that passkey opened.
- **A passkey the console did not keep.** Once the browser has made one, a
  refusal leaves it on the device, where it would open nothing. The page then
  asks the browser to forget it (`PublicKeyCredential.signalUnknownCredential`,
  where the browser has it), says to delete it there, and lists the passkeys
  again; after a failure that may have kept it, it only says to look.
- **The ceremony stays out of the page.** The platform's handle for it travels
  in its own cookie, `__Host-aule_admin_passkey`
  (`Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Strict`), never in a body
  a script can read, and is cleared once it is used.
- **Nothing is passed on as it came.** The console builds the browser's
  credential again from the fields the platform reads (`src/passkeys.ts`),
  each checked for its shape and length, and checks the name as the platform
  does.
- **Deleting a passkey here does not delete it from the device.** The dialog
  says to delete it there too, from the device or the password manager, and
  that the sessions it opened end: this one included, if it came in with
  that passkey, and the page then goes to the sign-in.

## Settings

The image starts Node with these names and nothing else (`env -i` in the
Dockerfile), so the operator's token, the database's password and the other
secrets of the shared env file never reach the process.

| Variable | Default | |
|---|---|---|
| `ADMIN_HOST` | `127.0.0.1` | Where it listens. With `compose.yaml` it comes from the shell's `AULE_ADMIN_HOST`; the server's wrapper sets `0.0.0.0` for the Worker |
| `ADMIN_PORT` | `8092` | |
| `ADMIN_PUBLIC_URL` | `https://admin.meetaule.com` | The console's origin: the one `Origin` a write may carry. `http://localhost:<port>` or `http://127.0.0.1:<port>` to work locally. It must equal the platform's `AULE_ADMIN_PASSKEY_ORIGIN`, the one origin a passkey is accepted from (for passkeys, `localhost`, never `127.0.0.1`) |
| `ADMIN_EDGE_SECRET` | none | What the console's Worker adds to every request (`X-Edge-Secret`, its own secret `EDGE_SECRET`): at least 32 characters, such as `openssl rand -hex 32`. Set, every request without it gets the same 404, except `/healthz` from this machine, and the client address the Worker passes on (`X-Client-IP`) counts for the sign-in's limits. Required when `ADMIN_HOST` is not loopback. With `compose.yaml` it comes from the console's own env file (`infra/server/README.md`) |
| `AULE_PLATFORM_URL` | required | Where the platform answers, as in `.env.example` |
| `AULE_ADMIN_EMAILS` | required | The team's addresses, read as the platform reads them. A change needs a restart of both |
| `AULE_COMMIT` | `unknown` | The commit the image is built from |

It never reads `AULE_ADMIN_TOKEN` (`test/config.test.ts` checks it), and the
image never hands it one (`test/image.test.ts`).

## Sign-in

- **A code by mail, for the team only.** The console asks for a code only for
  an address in `AULE_ADMIN_EMAILS`, through the platform's
  `POST /v1/auth/team/start`, which mails it only to an address on its own list
  that has a guardian account. Any other address gets the same answer and no
  mail. Asking for a code is answered at once, before the platform is asked, so
  the time it takes tells nothing either.
- **Codes of the team's own.** The platform keeps the console's codes apart from
  a family's (`apps/platform`, «Aule's team»): asking for one leaves nothing that
  the family sign-in on the playground can read or use up, so no family-facing
  request can tell a team address by it.
- **The same answer for every failure.** A wrong, used or expired code, an
  address that is not the team's, a team address with no account, a person the
  platform does not count as the team, and a platform that fails: all are
  `403 wrong_code`, and none comes sooner than 500 ms after the code's body was
  read.
- **It never makes an account.** The platform's team routes take no name or
  link, so a team address with no guardian account cannot sign in: that person
  signs up once on the playground.
- **Limits per client**, in memory (a restart clears them). The client is the
  address the Worker read from Cloudflare (`X-Client-IP`), believed only with
  the Worker's secret, and an IPv6 address counts by its /64:
  - 3 code requests an hour per address and client, and 10 per client;
  - 5 wrong codes an hour and 10 a day per address and client, and 10 an hour
    and 20 a day per client, which a success clears; each try counts before the
    platform is asked, so tries sent together cannot all get through;
  - 20 passkey sign-ins started an hour per client;
  - 10 failed passkey sign-ins an hour per client, counted before the platform
    is asked and cleared by a success. They are counted apart from wrong codes:
    a signature cannot be guessed, so a passkey a browser keeps offering after
    it was deleted never holds back the code, nor wrong codes a passkey;
  - 600 sign-in requests a minute in all, a breaker far above the team's use. A
    request counts there only once its body is read and only with its client's
    own counters, so a malformed one, or one past its client's limits, adds
    nothing to it.

  So a stranger's requests and wrong codes hold back only that stranger: the
  team member, on another connection, still gets in. Only many clients at once
  can trip the breaker, and then a Cloudflare rate-limiting rule on
  `admin.meetaule.com/api/signin/*` is the answer. Every limit applies to every
  address alike, so reaching one tells nothing. Each counter keeps at most
  10,000 keys (addresses by their hash); when full it forgets the one heard from
  longest ago, rather than refuse everyone new. With the platform's own limits
  (five team codes an hour per address, five tries a code), one client gets at
  most 10 tries a day at a team address.
- **Or a passkey.** Where the browser has the WebAuthn JSON methods, the page
  offers «Entrar con passkey» above the address. No address is typed: the
  console asks the platform for a ceremony, the same for everyone, keeps its
  handle in its own cookie (`__Host-aule_admin_passkey`, 5 minutes,
  `HttpOnly; Secure; SameSite=Strict`), the browser's own picker shows the
  passkeys the person has for the console, and its answer goes to the platform,
  built again (`src/passkeys.ts`; where a password manager's credential cannot
  write its own JSON, `public/credential.js` writes it). The platform checks it
  (`apps/platform`, «Aule's team»), opens the same 12-hour session a code does
  and names whose passkey it was; the console then checks that address against
  its own team list too. Every failure, the platform's refusal, someone off
  either list, a missing or used ceremony and a platform that fails alike, is
  `403 passkey_failed`, no sooner than 500 ms after the body was read; for
  someone off the console's list, the session the platform opened is ended at
  once and the log says `passkey_off_team`. A member creates passkeys on
  «Passkeys»; the code keeps working beside them. The page says so, and words a
  failure for what can be done: a cancel or no passkey here, a browser that
  will not, a password manager that could not.
- **Removing someone from the team** takes either list: off this console's
  `AULE_ADMIN_EMAILS`, they get no code and their passkeys open nothing here,
  and the console's restart signs everyone out; the platform's list, read at
  its start, then catches up at its next restart (`infra/server/README.md`,
  «Taking someone off the team»).
- **The cookie** is `__Host-aule_admin`: 32 random bytes, host-only,
  `Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`. The platform token
  it stands for stays in the console's memory; it is never sent to the browser,
  logged or written anywhere. A token from the playground's cookie is no use here.
- **A session lasts 12 hours from sign-in, or 2 hours without a request**, at
  most 20 at once (a new one ends the oldest). A restart signs the team out.
- **The platform's session underneath lasts 12 hours too**, not a family's 30
  days: the platform's team sign-in opens it so. The console also ends it
  whenever its own session ends: on «Salir», expiry, eviction, a refusal of the
  token, and SIGTERM. A process killed without SIGTERM leaves its platform
  sessions valid, held by nobody, for the rest of their 12 hours.
- **Signing out** (`POST /api/signout`) ends the console's session, asks the
  platform to end that one session (5 s at most) and clears the cookie, whatever
  the platform answered. The person's other sessions, the playground's
  included, stay.
- A team member held back by the limits on their own connection gets in again
  after a restart of the console, which signs the whole team out.

## Headers and request rules

Every answer carries:

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
X-Robots-Tag: noindex, nofollow
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Cache-Control: no-store
```

A file asked for at its fingerprint is kept for a year, any other file is
checked against its ETag, and pages, the API and errors are never kept. The
pages have no inline code, load one module of their own each, and draw every
value with `textContent`; nothing of another site is loaded, analytics
included (`test/page.test.mjs`).

**Only through the Worker.** With `ADMIN_EDGE_SECRET` set, a request without
the secret gets `404 {"error":"not_found"}` at every address, the same as a
path that does not exist, compared in constant time; only `/healthz` from this
machine (the container's check and the watch) answers without it.

**Writes** (every POST) need `Origin` equal to `ADMIN_PUBLIC_URL` (never
compared with `Host`, which behind the Worker names the server),
`Sec-Fetch-Site: same-origin` when the browser sends it, `Content-Type:
application/json`, and a JSON object of at most 4 KB, or 16 KB where it carries
a passkey the browser made or used (`/api/passkeys/create`,
`/api/signin/passkey/finish`).

**The log** has one fixed event per line, with numbers and yes-or-no fields
only: never an address, a code, a token, a cookie, a body, a request's address,
a client's address or the platform's words. A passkey made or deleted is
`passkey_created` or `passkey_deleted`, a sign-in by passkey is `signed_in`
with `passkey=true`, and a passkey of someone off this console's list is
`passkey_off_team`, with nothing of the passkey.

## Running it locally

With a platform on `http://127.0.0.1:8091` that can send mail, and your address
in its `AULE_ADMIN_EMAILS` (and, for passkeys, `AULE_ADMIN_PASSKEY_RP_ID=localhost`
and `AULE_ADMIN_PASSKEY_ORIGIN=http://localhost:8092` in its settings):

```sh
pnpm install --frozen-lockfile
cd apps/admin
AULE_PLATFORM_URL=http://127.0.0.1:8091 AULE_ADMIN_EMAILS=you@example.org \
  ADMIN_PUBLIC_URL=http://localhost:8092 npm start
# http://localhost:8092/ (the browser keeps a Secure cookie for localhost)
```

## Tests

```sh
pnpm --filter @aule/admin typecheck
cd apps/admin && npm test
# The image, from the repository root (CI builds it too):
docker build -f apps/admin/Dockerfile --build-arg AULE_COMMIT=$(git rev-parse HEAD) -t aule-admin:local .
```

`test/fake-platform.ts` stands in for the platform; the clock, the code check's
floor and the platform's timeout are injected, so the tests are fast. They cover
every route, the headers on every kind of answer, the Worker's secret, the
sign-in's neutral answers and its limits per client (a burst sent together, a
slow body, IPv6 by its /64), the sessions and their revocation (SIGTERM
included), the logs, the
pages' rules, `pilot.js`'s arithmetic (`test/pilot.test.mjs`, moved with it) and
`labels.js`'s words (`test/labels.test.mjs`), and a passkey's JSON written by
hand (`test/credential.test.mjs`). The pages' scripts also run in a
fake document (`test/dom.mjs`) that cannot read HTML from a string: «En vivo»'s
line, its table, what it draws as text, and how it asks again
(`test/live.test.mjs`); «Familias»'s filters from the address, its rows and
links, its pages and its grants (`test/families.test.mjs`); and a family's page,
its id checked, every section drawn as text, and its lists a page at a time
(`test/family.test.mjs`); and «Passkeys», with a stand-in for the browser's
WebAuthn: its list as text, «Crear passkey» from the name to the passkey sent
back, what each failure says, a browser that cannot, and «Borrar»
(`test/passkeys.test.mjs`); and the sign-in page's «Entrar con passkey»
(`test/signin-page.test.mjs`).
