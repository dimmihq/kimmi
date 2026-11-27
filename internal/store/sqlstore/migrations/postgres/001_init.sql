CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  preferences TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  last_login_at BIGINT
);
CREATE INDEX users_org ON users(org_id);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  accepted_at BIGINT
);
CREATE INDEX invitations_org ON invitations(org_id);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  access TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  expires_at BIGINT
);
CREATE INDEX api_tokens_user ON api_tokens(org_id, user_id);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  platform TEXT NOT NULL,
  origin TEXT NOT NULL,
  timezone TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  origins TEXT NOT NULL DEFAULT '[]',
  settings TEXT NOT NULL DEFAULT '{}',
  retention_days INTEGER NOT NULL,
  keep_starred BOOLEAN NOT NULL,
  created_at BIGINT NOT NULL,
  deleted_at BIGINT
);
CREATE UNIQUE INDEX projects_slug ON projects(org_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user ON project_members(user_id);

CREATE TABLE visitors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  external_id TEXT,
  name TEXT,
  email TEXT,
  traits TEXT,
  country TEXT NOT NULL,
  country_code TEXT NOT NULL,
  city TEXT NOT NULL,
  device TEXT NOT NULL,
  browser TEXT NOT NULL,
  os TEXT NOT NULL,
  first_seen BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  sessions INTEGER NOT NULL,
  UNIQUE (project_id, anonymous_id)
);
CREATE INDEX visitors_last_seen ON visitors(project_id, last_seen);

CREATE TABLE sessions (
  id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  last_at BIGINT NOT NULL,
  duration_ms BIGINT NOT NULL,
  active_ms BIGINT NOT NULL,
  pages INTEGER NOT NULL,
  entry_path TEXT NOT NULL,
  exit_path TEXT NOT NULL,
  urls TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  keypresses INTEGER NOT NULL,
  rage_clicks INTEGER NOT NULL,
  dead_clicks INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  viewport_w INTEGER NOT NULL,
  viewport_h INTEGER NOT NULL,
  device TEXT NOT NULL,
  browser TEXT NOT NULL,
  os TEXT NOT NULL,
  country_code TEXT NOT NULL,
  city TEXT NOT NULL,
  referrer TEXT NOT NULL,
  release TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  block_count INTEGER NOT NULL,
  last_seq BIGINT NOT NULL,
  seen BOOLEAN NOT NULL DEFAULT FALSE,
  starred BOOLEAN NOT NULL DEFAULT FALSE,
  sealed BOOLEAN NOT NULL DEFAULT FALSE,
  sealed_key TEXT,
  sealed_chunks TEXT,
  deleted_at BIGINT,
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);
CREATE TABLE sessions_default PARTITION OF sessions DEFAULT;
CREATE INDEX sessions_id ON sessions(id);
CREATE INDEX sessions_project_started ON sessions(project_id, started_at);
CREATE INDEX sessions_project_last ON sessions(project_id, last_at);
CREATE INDEX sessions_visitor ON sessions(visitor_id);
CREATE INDEX sessions_unsealed ON sessions(last_at) WHERE sealed = FALSE;

CREATE TABLE blocks (
  session_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  project_id TEXT NOT NULL,
  file_key TEXT NOT NULL,
  "offset" BIGINT NOT NULL,
  length BIGINT NOT NULL,
  first_ts BIGINT NOT NULL,
  last_ts BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX blocks_file ON blocks(file_key);

CREATE TABLE usage_daily (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  bytes BIGINT NOT NULL,
  PRIMARY KEY (project_id, day)
);
