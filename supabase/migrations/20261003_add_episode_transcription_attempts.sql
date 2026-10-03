-- Kanban #7: transcription worker counts attempts per episode so an episode that keeps
-- failing is marked `failed` instead of being retried forever.
ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS transcription_attempts INT NOT NULL DEFAULT 0;
