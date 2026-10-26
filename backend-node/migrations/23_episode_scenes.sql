-- Shared scene identity. scenes.episode_id remains the original owning episode.
CREATE TABLE IF NOT EXISTS episode_scenes (
  episode_id INTEGER NOT NULL,
  scene_id INTEGER NOT NULL,
  PRIMARY KEY (episode_id, scene_id)
);
CREATE INDEX IF NOT EXISTS idx_episode_scenes_scene_id ON episode_scenes(scene_id);
