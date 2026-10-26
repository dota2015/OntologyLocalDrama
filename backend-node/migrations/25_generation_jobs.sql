CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  drama_id INTEGER NOT NULL REFERENCES dramas(id),
  episode_id INTEGER REFERENCES episodes(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  options TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS generation_jobs_scope ON generation_jobs(drama_id,episode_id,created_at);
CREATE TABLE IF NOT EXISTS generation_job_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES generation_jobs(id),
  position TEXT NOT NULL,
  action TEXT NOT NULL,
  label TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  child_type TEXT,
  child_id TEXT,
  error TEXT,
  UNIQUE(job_id,position)
);
