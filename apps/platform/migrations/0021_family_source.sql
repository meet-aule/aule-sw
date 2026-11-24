-- Generated from the entities by `cargo run --example migration`.
ALTER TABLE "families" ADD COLUMN "source" text;
-- Written by hand: the link a family signed up from is one of the short codes
-- `signin::source_code` accepts, or null. Families from before keep null:
-- where they came from was never recorded.
ALTER TABLE "families" ADD CONSTRAINT "families_source_check" CHECK ("source" ~ '^[a-z][a-z0-9-]{0,23}$');
