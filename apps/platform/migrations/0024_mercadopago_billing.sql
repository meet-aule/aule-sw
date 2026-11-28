-- Generated from the entities by `cargo run --example migration`.
CREATE TABLE "billing_checkouts" ( "id" uuid NOT NULL PRIMARY KEY, "family_id" uuid, "active_family_id" uuid UNIQUE, "kind" varchar NOT NULL, "amount_cents" bigint NOT NULL, "quantity" integer NOT NULL, "included_months" integer NOT NULL, "activated_at" timestamp with time zone, "currency" varchar NOT NULL, "language" varchar NOT NULL, "buyer" jsonb NOT NULL, "status" varchar NOT NULL, "provider_id" varchar UNIQUE, "checkout_url" varchar, "created_at" timestamp with time zone NOT NULL, "updated_at" timestamp with time zone NOT NULL, "checked_at" timestamp with time zone, "cancelled_at" timestamp with time zone, CONSTRAINT "fk-billing_checkouts-family_id" FOREIGN KEY ("family_id") REFERENCES "families" ("id") ON DELETE SET NULL );
CREATE TABLE "billing_payments" ( "id" varchar NOT NULL PRIMARY KEY, "checkout_id" uuid NOT NULL, "access_id" uuid, "status" varchar NOT NULL, "amount_cents" bigint NOT NULL, "currency" varchar NOT NULL, "approved_at" timestamp with time zone, "updated_at" timestamp with time zone NOT NULL, "notified_status" varchar, "merchant_notified_status" varchar, CONSTRAINT "fk-billing_payments-checkout_id" FOREIGN KEY ("checkout_id") REFERENCES "billing_checkouts" ("id") ON DELETE CASCADE );

ALTER TABLE billing_checkouts ADD CONSTRAINT billing_kind CHECK (kind IN ('plan', 'device'));
ALTER TABLE billing_checkouts ADD CONSTRAINT billing_amount CHECK (amount_cents > 0 AND currency = 'PEN');
ALTER TABLE billing_checkouts ADD CONSTRAINT billing_quantity CHECK (quantity BETWEEN 1 AND 10 AND included_months BETWEEN 0 AND 30);
CREATE INDEX billing_due ON billing_checkouts(checked_at, created_at);
CREATE INDEX billing_buyer ON billing_checkouts(lower(buyer->>'email')) WHERE kind = 'device';
CREATE INDEX billing_checkout_payments ON billing_payments(checkout_id);

ALTER TABLE billing_checkouts ADD CONSTRAINT billing_active_family CHECK (active_family_id IS NULL OR (kind = 'plan' AND active_family_id = family_id AND cancelled_at IS NULL));
