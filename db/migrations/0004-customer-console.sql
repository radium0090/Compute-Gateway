CREATE TABLE customer_users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('pending_verification', 'active', 'disabled')),
  email_verified_at timestamptz,
  failed_login_count integer NOT NULL DEFAULT 0
    CHECK (failed_login_count >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT customer_users_email_normalized CHECK (email = lower(email)),
  CONSTRAINT customer_users_display_name_length CHECK (
    char_length(display_name) BETWEEN 1 AND 100
  ),
  CONSTRAINT customer_users_password_hash_format CHECK (
    password_hash ~ '^scrypt\$v=1\$N=[0-9]+\$r=[0-9]+\$p=[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT customer_users_verified_state CHECK (
    (status = 'pending_verification' AND email_verified_at IS NULL)
    OR status IN ('active', 'disabled')
  )
);

CREATE UNIQUE INDEX customer_users_email_unique_idx
  ON customer_users (lower(email));
CREATE INDEX customer_users_tenant_idx ON customer_users (tenant_id);

CREATE TABLE customer_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_token_hash text NOT NULL CHECK (csrf_token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  CONSTRAINT customer_sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT customer_sessions_expiry_after_creation CHECK (
    expires_at > created_at
  )
);

CREATE INDEX customer_sessions_user_expiry_idx
  ON customer_sessions (user_id, expires_at);
CREATE INDEX customer_sessions_expiry_idx ON customer_sessions (expires_at);

CREATE TABLE customer_one_time_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT customer_tokens_hash_unique UNIQUE (token_hash),
  CONSTRAINT customer_tokens_expiry_after_creation CHECK (
    expires_at > created_at
  ),
  CONSTRAINT customer_tokens_consumed_after_creation CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  )
);

CREATE INDEX customer_tokens_user_purpose_idx
  ON customer_one_time_tokens (user_id, purpose, created_at DESC);
CREATE INDEX customer_tokens_expiry_idx
  ON customer_one_time_tokens (expires_at);

CREATE TABLE customer_tenant_entitlements (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'active', 'suspended')),
  plan_code text NOT NULL CHECK (plan_code ~ '^[a-z][a-z0-9_-]{1,31}$'),
  allowed_model_patterns jsonb NOT NULL DEFAULT '[]'::jsonb,
  allow_streaming boolean NOT NULL DEFAULT false,
  allow_tools boolean NOT NULL DEFAULT false,
  requests_per_minute integer NOT NULL DEFAULT 1
    CHECK (requests_per_minute BETWEEN 1 AND 10000),
  max_concurrent_requests integer NOT NULL DEFAULT 1
    CHECK (max_concurrent_requests BETWEEN 1 AND 1000),
  max_request_tokens integer NOT NULL DEFAULT 2048
    CHECK (max_request_tokens BETWEEN 1 AND 1000000),
  max_output_tokens integer NOT NULL DEFAULT 256
    CHECK (max_output_tokens BETWEEN 1 AND 1000000),
  max_active_api_keys integer NOT NULL DEFAULT 1
    CHECK (max_active_api_keys BETWEEN 1 AND 100),
  key_ttl_days integer NOT NULL DEFAULT 30
    CHECK (key_ttl_days BETWEEN 1 AND 3650),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT customer_entitlements_models_array CHECK (
    jsonb_typeof(allowed_model_patterns) = 'array'
  )
);

CREATE TABLE business_inquiries (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  email text NOT NULL CHECK (email = lower(email)),
  company text CHECK (company IS NULL OR char_length(company) <= 160),
  message text NOT NULL CHECK (char_length(message) BETWEEN 10 AND 4000),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'in_progress', 'closed', 'deleted')),
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 128),
  consented_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX business_inquiries_status_created_idx
  ON business_inquiries (status, created_at DESC);

CREATE TABLE customer_audit_events (
  id uuid PRIMARY KEY,
  actor_customer_user_id uuid
    REFERENCES customer_users(id) ON DELETE SET NULL,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  target_type text NOT NULL CHECK (target_type ~ '^[a-z][a-z0-9_-]{2,63}$'),
  target_id text,
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 128),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  CONSTRAINT customer_audit_metadata_object CHECK (
    jsonb_typeof(metadata) = 'object'
  )
);

CREATE INDEX customer_audit_events_tenant_created_idx
  ON customer_audit_events (tenant_id, created_at DESC);
