CREATE TABLE admin_users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  must_change_password boolean NOT NULL DEFAULT true,
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT admin_users_email_normalized CHECK (email = lower(email)),
  CONSTRAINT admin_users_display_name_length CHECK (
    char_length(display_name) BETWEEN 1 AND 100
  ),
  CONSTRAINT admin_users_password_hash_format CHECK (
    password_hash ~ '^scrypt\$v=1\$N=[0-9]+\$r=[0-9]+\$p=[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'
  )
);

CREATE UNIQUE INDEX admin_users_email_unique_idx ON admin_users (lower(email));

CREATE TABLE admin_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_token_hash text NOT NULL CHECK (csrf_token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  CONSTRAINT admin_sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT admin_sessions_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX admin_sessions_user_expiry_idx
  ON admin_sessions (user_id, expires_at);

CREATE INDEX admin_sessions_expiry_idx ON admin_sessions (expires_at);

CREATE TABLE operator_audit_events (
  id uuid PRIMARY KEY,
  actor_admin_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  target_type text NOT NULL CHECK (target_type ~ '^[a-z][a-z0-9_-]{2,63}$'),
  target_id text,
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 128),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  CONSTRAINT operator_audit_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX operator_audit_events_created_at_idx
  ON operator_audit_events (created_at DESC);

CREATE INDEX operator_audit_events_actor_created_idx
  ON operator_audit_events (actor_admin_user_id, created_at DESC);
