-- Create beta_requests table for Beta Registration System
-- Public can insert their email to join the waitlist
-- Only service role can read/manage all entries (admin operations)

CREATE TABLE IF NOT EXISTS beta_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ
);

-- Index for status lookups (admin dashboard filtering)
CREATE INDEX IF NOT EXISTS idx_beta_requests_status
  ON beta_requests(status);

-- Index for email lookups
CREATE INDEX IF NOT EXISTS idx_beta_requests_email
  ON beta_requests(email);

-- Index for sorting by created_at DESC (admin dashboard default order)
CREATE INDEX IF NOT EXISTS idx_beta_requests_created_at
  ON beta_requests(created_at DESC);

-- Enable Row Level Security
ALTER TABLE beta_requests ENABLE ROW LEVEL SECURITY;

-- No public access policies: only service role (which bypasses RLS) can read/write.
-- The public beta registration API uses the service role client to insert.
-- The admin API uses the service role client to read and update.

COMMENT ON TABLE beta_requests IS 'Beta waitlist registrations. Managed exclusively via service role (admin API routes).';
