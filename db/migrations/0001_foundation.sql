CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  key_hash text NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  environment text NOT NULL
    CHECK (environment IN ('development', 'test', 'staging', 'production')),
  status text NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
  policy jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  last_used_at timestamptz,
  CONSTRAINT api_keys_public_id_unique UNIQUE (public_id),
  CONSTRAINT api_keys_expiry_after_creation
    CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX api_keys_active_tenant_expiration_idx
  ON api_keys (tenant_id, expires_at)
  WHERE status = 'active';
