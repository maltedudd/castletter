-- NIAS-61: whether a user is an admin is stored per user instead of a fixed e-mail address in
-- the code. A separate table, not a column in user_settings: users may update their own
-- user_settings row and could otherwise make themselves admin.
--
-- Users can read their own roles; only the service role grants or revokes them (no write
-- policies, no write grants for anon/authenticated). Grant further admins with:
--   INSERT INTO user_roles (user_id, role)
--   SELECT id, 'admin' FROM auth.users WHERE lower(email) = lower('<email>')
--   ON CONFLICT DO NOTHING;
--
-- The previously hard-coded admin is taken over. Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CONSTRAINT user_roles_role_check CHECK (role IN ('admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, role)
);

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_roles FROM anon, authenticated;
GRANT SELECT ON user_roles TO authenticated;

DROP POLICY IF EXISTS "Users can view own roles" ON user_roles;
CREATE POLICY "Users can view own roles"
  ON user_roles FOR SELECT
  USING (auth.uid() = user_id);

INSERT INTO user_roles (user_id, role)
SELECT id, 'admin' FROM auth.users WHERE lower(email) = 'malte.dudd@gmail.com'
ON CONFLICT DO NOTHING;
