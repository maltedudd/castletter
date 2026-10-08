-- Kanban #38: per-user style of the AI summaries. The tone preset and an optional, bounded
-- prompt addition apply to the single summaries and to the integrated digest overview. The
-- addition only refines style and perspective; the app keeps truth, source and safety rules
-- in force. Existing users keep the neutral tone without an addition. RLS is unchanged (the
-- own-row policies of user_settings apply). Idempotent: safe to run twice.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS summary_tone TEXT NOT NULL DEFAULT 'neutral',
  ADD COLUMN IF NOT EXISTS summary_prompt_addition TEXT;

ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_summary_tone_check;
ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_summary_tone_check
    CHECK (summary_tone IN ('neutral', 'concise', 'analytical', 'warm'));

ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_summary_prompt_addition_check;
ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_summary_prompt_addition_check
    CHECK (summary_prompt_addition IS NULL OR char_length(summary_prompt_addition) BETWEEN 1 AND 500);

COMMENT ON COLUMN user_settings.summary_tone IS
  'Tone of the AI summaries and the digest overview: neutral (sachlich), concise (prägnant), analytical (analytisch), warm';
COMMENT ON COLUMN user_settings.summary_prompt_addition IS
  'Optional reader addition (max. 500 characters) that refines style and perspective of the summaries; cannot override truth, source or safety rules';
