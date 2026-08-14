CREATE TABLE demo_oauth_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT demo_oauth_state_expiry_after_creation
    CHECK (expires_at > created_at),
  CONSTRAINT demo_oauth_state_consumption_after_creation
    CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX demo_oauth_states_expiry_idx
  ON demo_oauth_states (expires_at);

CREATE TABLE demo_claims (
  id uuid PRIMARY KEY,
  identity_hash text NOT NULL CHECK (identity_hash ~ '^[a-f0-9]{64}$'),
  api_key_id uuid NOT NULL UNIQUE REFERENCES api_keys(id) ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT demo_claim_expiry_after_claim
    CHECK (expires_at > claimed_at)
);

CREATE INDEX demo_claims_identity_claimed_idx
  ON demo_claims (identity_hash, claimed_at DESC);

CREATE INDEX demo_claims_claimed_idx
  ON demo_claims (claimed_at DESC);
