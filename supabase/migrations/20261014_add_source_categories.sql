-- Kanban #48: user-defined source categories. A category is a private, named group of the
-- user's sources with its own position; the daily digest is grouped by categories in that
-- order (uncategorised sources last). A source belongs to at most one category
-- (podcast_subscriptions.category_id). Categories only organise sources and the digest – they
-- change nothing about ingestion, summaries, immediate delivery or deduplication.
--
-- Requires PostgreSQL 15+ (ON DELETE SET NULL with a column list).
-- Existing rows are not changed: every source starts without a category.
-- Idempotent: safe to run twice.

-- ─── Categories ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS source_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Trimmed, 1–50 characters (same limit as src/lib/sources/categories.mjs).
  name TEXT NOT NULL CONSTRAINT source_categories_name_check
    CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 50),
  -- The user's order; gaps (after a deletion) are fine, only the relative order counts.
  position INTEGER NOT NULL CONSTRAINT source_categories_position_check CHECK (position >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Deferred, so reorder_source_categories can swap positions within one transaction.
  CONSTRAINT source_categories_user_position_key UNIQUE (user_id, position) DEFERRABLE INITIALLY DEFERRED,
  -- Target of the composite foreign key from podcast_subscriptions (same user only).
  CONSTRAINT source_categories_user_id_id_key UNIQUE (user_id, id)
);

-- Names are unique per user, ignoring case.
CREATE UNIQUE INDEX IF NOT EXISTS source_categories_user_name_key
  ON source_categories (user_id, lower(name));

-- A new category without a position goes to the end of the user's list.
CREATE OR REPLACE FUNCTION set_source_category_position()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.position IS NULL THEN
    SELECT COALESCE(MAX(position) + 1, 0) INTO NEW.position
    FROM source_categories
    WHERE user_id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_source_category_position ON source_categories;
CREATE TRIGGER set_source_category_position
  BEFORE INSERT ON source_categories
  FOR EACH ROW EXECUTE FUNCTION set_source_category_position();

DROP TRIGGER IF EXISTS update_source_categories_updated_at ON source_categories;
CREATE TRIGGER update_source_categories_updated_at
  BEFORE UPDATE ON source_categories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Private per user: every operation only on the user's own rows.
ALTER TABLE source_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own source categories" ON source_categories;
CREATE POLICY "Users can view own source categories"
  ON source_categories FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own source categories" ON source_categories;
CREATE POLICY "Users can create own source categories"
  ON source_categories FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own source categories" ON source_categories;
CREATE POLICY "Users can update own source categories"
  ON source_categories FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own source categories" ON source_categories;
CREATE POLICY "Users can delete own source categories"
  ON source_categories FOR DELETE
  USING (auth.uid() = user_id);

COMMENT ON TABLE source_categories IS
  'Kanban #48: private, named groups of a user''s sources; the daily digest is grouped by them in position order';
COMMENT ON COLUMN source_categories.position IS
  'The user''s order of categories (ascending); set by reorder_source_categories, new categories go last';

-- ─── Sources: at most one category ────────────────────────────────────

ALTER TABLE podcast_subscriptions
  ADD COLUMN IF NOT EXISTS category_id UUID;

-- The composite key only accepts a category of the same user – also for the service role.
-- Deleting a category only clears category_id: the source and its episodes stay.
ALTER TABLE podcast_subscriptions
  DROP CONSTRAINT IF EXISTS podcast_subscriptions_category_fkey;
ALTER TABLE podcast_subscriptions
  ADD CONSTRAINT podcast_subscriptions_category_fkey
  FOREIGN KEY (user_id, category_id)
  REFERENCES source_categories (user_id, id)
  ON DELETE SET NULL (category_id);

CREATE INDEX IF NOT EXISTS idx_podcast_subscriptions_category
  ON podcast_subscriptions (user_id, category_id)
  WHERE category_id IS NOT NULL;

COMMENT ON COLUMN podcast_subscriptions.category_id IS
  'Kanban #48: the user''s category of this source (NULL = none, shown under "Weitere Quellen"); only orders the daily digest';

-- ─── Reordering ───────────────────────────────────────────────────────

-- Sets the order of all of the caller's categories at once (positions 0..n-1 in array order).
-- SECURITY INVOKER: row level security applies. The list must contain exactly the caller's
-- categories – none missing, none foreign, none twice – otherwise nothing changes.
CREATE OR REPLACE FUNCTION reorder_source_categories(category_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  owner UUID := auth.uid();
BEGIN
  IF owner IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  IF category_ids IS NULL
     OR cardinality(category_ids) <> (SELECT count(DISTINCT id) FROM unnest(category_ids) AS ids(id))
     OR cardinality(category_ids) <> (SELECT count(*) FROM source_categories WHERE user_id = owner)
     OR EXISTS (
       SELECT 1 FROM unnest(category_ids) AS ids(id)
       WHERE NOT EXISTS (SELECT 1 FROM source_categories c WHERE c.id = ids.id AND c.user_id = owner)
     ) THEN
    RAISE EXCEPTION 'category list does not match the user''s categories' USING ERRCODE = '22023';
  END IF;

  UPDATE source_categories c
  SET position = ordered.ord - 1
  FROM unnest(category_ids) WITH ORDINALITY AS ordered(id, ord)
  WHERE c.id = ordered.id
    AND c.user_id = owner
    AND c.position IS DISTINCT FROM ordered.ord - 1;
END;
$$;

REVOKE ALL ON FUNCTION reorder_source_categories(UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION reorder_source_categories(UUID[]) FROM anon;
GRANT EXECUTE ON FUNCTION reorder_source_categories(UUID[]) TO authenticated;
