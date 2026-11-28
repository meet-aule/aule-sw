# Billing

The platform owns the payment ledger. The store is a client with its own narrow
bearer token, never the operator token. Mercado Pago credentials exist only in
platform and worker environment files. Neither Aule frontend receives a card,
card token, access token or webhook secret. Only the adult buyer's email goes to
the hosted checkout; shipping details remain in Aule and its company email.

## Current offer

- Device: S/100, delivery included within 30 days, only Lima Metropolitana and
  Callao. Three calendar months of tutoring per device.
- Tutoring: S/59 with explicit monthly renewal consent, when paid access opens.
- **Keep `AULE_FREE_ACCESS=1` in platform and playground.** The current owner
  decision is unlimited free tutoring. Monthly checkout and device-month
  redemption return 409 while that switch is on; included months remain reserved.
- Later, the verified purchase-email account activates included months from
  **My plan and payments**. An explicit confirmation cancels existing renewal,
  preserves time already paid for and starts the included period after it.
  Redemption does not enroll the account in future charges.

## Routes

Guardian session: `GET /v1/me/billing`, `POST /v1/me/billing/{subscribe,cancel,refresh,redeem}`.
The playground exposes these at `api/billing` and `api/billing/<action>` with
same-origin JSON checks for writes. The child's session and gates are unchanged.

Store token: `GET /v1/store/catalog`, `POST /v1/store/orders`,
`GET /v1/store/order?id=<uuid>`. Orders persist before an external checkout is
created. The caller supplies a random UUID once per attempt; replaying it with
different buyer details or quantity is rejected. Prices and delivery coverage
are checked by the platform, not accepted from the browser.

Staff session: `GET /v1/admin/orders`, shown at the console's `/orders` page.
It contains adult delivery and requested tax-receipt details. A paid-order email
also goes to `AULE_ORDERS_EMAIL`. SUNAT tax receipts and shipping remain the
company's fulfillment process; a payment confirmation is not a tax invoice.

Public provider callback: `<AULE_PAYMENTS_PUBLIC_URL>/api/payments/webhook`
forwards to `/v1/payments/webhook`. The old store callback forwards to the same
ledger. Configure **payment**, **subscription_preapproval** and
**subscription_authorized_payment** in Mercado Pago, with the matching signing
secret. Require HTTPS and preserve `data.id`, `x-signature` and `x-request-id`.

## Activation

1. Complete the account's phone/identity/email checks and create the application.
2. Put the payment fields documented in the root `.env.example` in a separate
   `/etc/aule/billing.env` (owner-only permissions). The server wrapper sets
   `AULE_BILLING_ENV_FILE`; Compose gives this file only to platform and worker.
   Do not put payment credentials in the shared `aule.env`. Configure
   `AULE_PLATFORM_URL` plus the same dedicated `AULE_STORE_TOKEN` in the store.
   Use the existing Linux host network and loopback; do not expose the platform port publicly.
3. Migrate/restart platform and worker, then playground, admin and store. The
   migration adds tables and indices; it does not rewrite existing access.
4. With sandbox credentials and `AULE_MP_LIVE_MODE=0`, complete hosted test
   checkout and verify the signed callback, persisted receipt, email, return
   status and the verified buyer's reserved months. Use provider test accounts.
5. Confirm production account readiness and collector ID before live mode.
   Keep free access enabled. No real charge is part of the automated tests.

## Processing and recovery

A signed event is acknowledged after its job is durable. The worker reads the
resource from Mercado Pago, verifies seller, environment, reference, amount and
currency, then writes the receipt and entitlement in one locked transaction.
Payment IDs are unique; duplicate events do not extend paid time. Cancellation
keeps paid access. Full refunds and chargebacks revoke only their own period,
and stale approvals cannot bring it back.

The worker rotates through due checkouts every minute (up to 20), checking each
at most every 15 minutes. Recent device orders and active subscriptions recover
missed events; cancelled subscriptions remain polled for 90 days. Signed events
still cover older receipts. Logs contain identifiers and safe error categories,
not provider bodies, buyer details or credentials.

After an ambiguous creation timeout, retry searches by the original reference;
it never blindly creates another subscription. An unresolved `creating` checkout
needs provider reconciliation/support before clearing it. Email jobs retry on
SMTP failure and track delivery state in the ledger. A process crash after SMTP
acceptance but before commit can repeat an email; it cannot duplicate access.

Deleting a family first stops renewal, or fails without deleting the account.
Financial and device delivery records remain independent of learner records;
plan contact data is cleared and the family link becomes null. No child data is
in the billing tables. These retained business records need the company's normal
retention and fulfillment process.

## Validation and rollout state

Local PostgreSQL tests cover receipt validation, concurrent duplicates, stale
updates after refunds, ambiguous creation recovery, cancellation, account
erasure, delivery coverage, free-period reservations and one-time redemption.
Frontend tests cover signed forwarding, origin checks, server pricing and
untrusted payment redirects. **Mock-provider tests are not a live integration
certification.** Account verification and hosted provider tests are required
before enabling sales; record their result in the release PR.

References: [pending subscriptions](https://www.mercadopago.com.pe/developers/es/docs/subscriptions/integration-configuration/subscription-no-associated-plan/pending-payments),
[webhooks](https://www.mercadopago.com.pe/developers/es/docs/subscriptions/additional-content/your-integrations/notifications/webhooks),
[API](https://www.mercadopago.com.pe/developers/en/reference/online-payments/subscriptions/overview).
