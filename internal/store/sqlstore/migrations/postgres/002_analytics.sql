CREATE TABLE visits (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  visitor_key TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  last_at BIGINT NOT NULL,
  pageviews INTEGER NOT NULL,
  actions INTEGER NOT NULL,
  engaged_ms BIGINT NOT NULL,
  entry_path TEXT NOT NULL,
  exit_path TEXT NOT NULL,
  referrer TEXT NOT NULL,
  channel TEXT NOT NULL,
  utm_source TEXT NOT NULL,
  utm_medium TEXT NOT NULL,
  utm_campaign TEXT NOT NULL,
  country_code TEXT NOT NULL,
  device TEXT NOT NULL,
  browser TEXT NOT NULL,
  os TEXT NOT NULL,
  language TEXT NOT NULL,
  viewport_w INTEGER NOT NULL,
  release TEXT NOT NULL,
  is_returning BOOLEAN NOT NULL,
  cookieless BOOLEAN NOT NULL
);
CREATE INDEX visits_project_started ON visits(project_id, started_at);
CREATE INDEX visits_visitor ON visits(project_id, visitor_key, last_at);

CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  visit_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  w INTEGER NOT NULL,
  num INTEGER NOT NULL,
  props TEXT NOT NULL
);
CREATE INDEX events_project_kind ON events(project_id, kind, ts);
CREATE INDEX events_visit ON events(visit_id);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at_ms BIGINT NOT NULL,
  body TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX notes_session ON notes(session_id);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  session_id TEXT NOT NULL,
  start_ms BIGINT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX shares_project ON shares(project_id);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  visit_id TEXT NOT NULL,
  visitor_key TEXT NOT NULL,
  path TEXT NOT NULL,
  body TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  seen BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX feedback_project ON feedback(project_id, created_at);

CREATE TABLE salts (
  day TEXT PRIMARY KEY,
  salt TEXT NOT NULL
);

CREATE TABLE project_state (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (project_id, name)
);
