ALTER TABLE risk_observations ADD COLUMN symbol_leverage integer CHECK (symbol_leverage >= 1);
ALTER TABLE order_observations ADD COLUMN order_type text NOT NULL;
ALTER TABLE order_observations ADD COLUMN time_in_force text NOT NULL;
ALTER TABLE score_samples ADD COLUMN policy_json jsonb;
ALTER TABLE score_samples ADD COLUMN mark_observation_id bigint REFERENCES market_observations(id);
ALTER TABLE score_samples ADD COLUMN risk_observation_id bigint REFERENCES risk_observations(id);
ALTER TABLE score_samples ADD COLUMN bid_observation_id bigint REFERENCES order_observations(id);
ALTER TABLE score_samples ADD COLUMN ask_observation_id bigint REFERENCES order_observations(id);
ALTER TABLE score_samples ADD CONSTRAINT nonzero_score_requires_evidence CHECK
  (delta_scaled = 0 OR (mark_observation_id IS NOT NULL AND risk_observation_id IS NOT NULL AND policy_json IS NOT NULL
    AND (bid_observation_id IS NOT NULL OR ask_observation_id IS NOT NULL)));
