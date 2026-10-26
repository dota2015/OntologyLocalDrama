CREATE TABLE IF NOT EXISTS video_batches (
  id TEXT PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id),
  drama_id INTEGER NOT NULL REFERENCES dramas(id),
  status TEXT NOT NULL DEFAULT 'running',
  continuity INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS video_batches_active_episode ON video_batches(episode_id) WHERE status IN ('running', 'stopping');
CREATE TABLE IF NOT EXISTS video_batch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES video_batches(id),
  storyboard_id INTEGER NOT NULL REFERENCES storyboards(id),
  position INTEGER NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  video_gen_id INTEGER REFERENCES video_generations(id),
  error TEXT,
  UNIQUE(batch_id, storyboard_id)
);
