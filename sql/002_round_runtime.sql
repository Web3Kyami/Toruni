-- Enrollment ownership is provisional until an independently observed order binds it.
CREATE UNIQUE INDEX one_claimed_account_per_round ON participants (round_id, claimed_account_id);
ALTER TABLE participants ADD COLUMN consent_at timestamptz NOT NULL;
ALTER TABLE quote_intents ADD COLUMN verification_error text;
ALTER TABLE quote_intents ADD COLUMN last_checked_at timestamptz;
ALTER TABLE quote_intents ADD COLUMN next_verify_at timestamptz;
ALTER TABLE quote_intents ADD COLUMN verification_failures integer NOT NULL DEFAULT 0 CHECK (verification_failures >= 0);
ALTER TABLE round_results ADD COLUMN bid_eligible_seconds integer NOT NULL DEFAULT 0 CHECK (bid_eligible_seconds >= 0);
ALTER TABLE round_results ADD COLUMN ask_eligible_seconds integer NOT NULL DEFAULT 0 CHECK (ask_eligible_seconds >= 0);
ALTER TABLE round_results ADD COLUMN two_sided_seconds integer NOT NULL DEFAULT 0 CHECK (two_sided_seconds >= 0);
ALTER TABLE round_results ADD COLUMN paused_seconds integer NOT NULL DEFAULT 0 CHECK (paused_seconds >= 0);
