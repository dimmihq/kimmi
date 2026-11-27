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
  sketch BLOB NOT NULL,
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

CREATE TABLE funnel_daily (
  project_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  funnel_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  visits INTEGER NOT NULL,
  PRIMARY KEY (project_id, day, funnel_id, step)
);

CREATE TABLE funnel_visits (
  visit_id TEXT NOT NULL,
  funnel_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  step INTEGER NOT NULL,
  PRIMARY KEY (visit_id, funnel_id)
);
CREATE INDEX funnel_visits_step ON funnel_visits(project_id, funnel_id, step, day);

CREATE TABLE known_visitors (
  project_id TEXT NOT NULL,
  visitor_key TEXT NOT NULL,
  first_week INTEGER NOT NULL,
  weeks TEXT NOT NULL,
  PRIMARY KEY (project_id, visitor_key)
);

CREATE TABLE cohort_weekly (
  project_id TEXT NOT NULL,
  cohort INTEGER NOT NULL,
  week INTEGER NOT NULL,
  visitors INTEGER NOT NULL,
  PRIMARY KEY (project_id, cohort, week)
);
