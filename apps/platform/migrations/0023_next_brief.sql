-- The plan for the child's next session, written ahead with the review of
-- this one so that it is ready when that session starts. Reviews from before
-- keep null: the next session's plan is then written at its start, as it was.
-- Written by hand, as `cargo run --example migration` words it.
ALTER TABLE "session_reviews" ADD COLUMN "next_brief" jsonb;
