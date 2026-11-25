-- Generated from the entities by `cargo run --example migration`.
CREATE TABLE "team_passkeys" ( "id" uuid NOT NULL PRIMARY KEY, "guardian_id" uuid NOT NULL, "credential_id" bytea NOT NULL UNIQUE, "user_handle" uuid NOT NULL, "passkey" jsonb NOT NULL, "label" varchar NOT NULL, "created_at" timestamp with time zone NOT NULL, "last_used_at" timestamp with time zone, CONSTRAINT "fk-team_passkeys-guardian_id" FOREIGN KEY ("guardian_id") REFERENCES "guardians" ("id") ON DELETE CASCADE );
ALTER TABLE "guardian_sessions" ADD COLUMN "passkey_id" uuid;
ALTER TABLE "guardian_sessions" ADD CONSTRAINT "fk-guardian_sessions-passkey_id" FOREIGN KEY ("passkey_id") REFERENCES "team_passkeys" ("id") ON DELETE CASCADE;
-- Written by hand: a credential id is 1 to 1023 bytes (WebAuthn's longest), a
-- name 1 to 60 characters, a member's passkeys are listed newest first, and
-- deleting a passkey finds the sessions it opened by an index.
ALTER TABLE "team_passkeys" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "team_passkeys" ADD CONSTRAINT "team_passkeys_credential_id_check" CHECK (octet_length("credential_id") BETWEEN 1 AND 1023);
ALTER TABLE "team_passkeys" ADD CONSTRAINT "team_passkeys_label_check" CHECK (char_length("label") BETWEEN 1 AND 60);
CREATE INDEX "team_passkeys_guardian" ON "team_passkeys" ("guardian_id", "created_at" DESC);
CREATE INDEX "guardian_sessions_passkey" ON "guardian_sessions" ("passkey_id") WHERE "passkey_id" IS NOT NULL;
