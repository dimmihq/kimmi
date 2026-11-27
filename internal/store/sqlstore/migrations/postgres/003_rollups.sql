ALTER TABLE visits ADD COLUMN counted TEXT NOT NULL DEFAULT '';
ALTER TABLE visits ADD COLUMN day INTEGER NOT NULL DEFAULT 0;
CREATE INDEX visits_project_day ON visits(project_id, day);
CREATE INDEX events_project_name ON events(project_id, kind, name, ts);

CREATE TABLE stats_daily (
  project_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  dim TEXT NOT NULL,
  k TEXT NOT NULL,
  visits INTEGER NOT NULL,
  pageviews INTEGER NOT NULL,
  bounces INTEGER NOT NULL,
  duration_ms BIGINT NOT NULL,
  new_visitors INTEGER NOT NULL,
  time_ms BIGINT NOT NULL,
  scroll_sum BIGINT NOT NULL,
  scroll_n INTEGER NOT NULL,
  exits INTEGER NOT NULL,
  sketch BYTEA NOT NULL,
  PRIMARY KEY (project_id, day, dim, k)
);

CREATE TABLE events_daily (
  project_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  n INTEGER NOT NULL,
  visits INTEGER NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  aux BIGINT NOT NULL,
  num INTEGER NOT NULL,
  first_ts BIGINT NOT NULL,
  last_ts BIGINT NOT NULL,
  label TEXT NOT NULL,
  props TEXT NOT NULL,
  last_visit TEXT NOT NULL,
  PRIMARY KEY (project_id, day, kind, name, path)
);
CREATE INDEX events_daily_name ON events_daily(project_id, kind, name, day);

CREATE TABLE heat_daily (
  project_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  path TEXT NOT NULL,
  device TEXT NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (project_id, day, path, device, x, y)
);
