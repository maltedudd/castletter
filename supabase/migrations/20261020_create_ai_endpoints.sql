-- NIAS-58: AI endpoints per purpose instead of a base URL fixed in code. One OpenAI-compatible
-- endpoint per purpose (transcription = audio → text, text_generation = summaries and digest
-- overview); a purpose without a row keeps using OpenRouter from the environment
-- (src/lib/ai/endpoints.mjs). Rows are written by the admin area only.
--
-- The API key is stored AES-256-GCM-encrypted (`v1:<iv>:<tag>:<ciphertext>`) with
-- AI_ENDPOINTS_ENCRYPTION_KEY, which lives only in the Vercel and worker environment;
-- api_key_hint keeps the last four characters for display.
--
-- Service role only: RLS without policies and no grants for anon/authenticated.
-- Existing data is not changed. Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS ai_endpoints (
  -- One endpoint per purpose.
  purpose TEXT PRIMARY KEY CONSTRAINT ai_endpoints_purpose_check
    CHECK (purpose IN ('transcription', 'text_generation')),
  -- Same limits as LIMITS in src/lib/ai/endpoints.mjs.
  name TEXT NOT NULL CONSTRAINT ai_endpoints_name_check
    CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 100),
  base_url TEXT NOT NULL CONSTRAINT ai_endpoints_base_url_check
    CHECK (base_url ~ '^https?://[^/?#[:space:]]+' AND char_length(base_url) <= 500),
  model TEXT NOT NULL CONSTRAINT ai_endpoints_model_check
    CHECK (model = btrim(model) AND char_length(model) BETWEEN 1 AND 200),
  -- NULL: keyless server (e.g. a local endpoint without authentication).
  api_key_encrypted TEXT CONSTRAINT ai_endpoints_api_key_encrypted_check
    CHECK (api_key_encrypted IS NULL OR api_key_encrypted LIKE 'v1:%'),
  api_key_hint TEXT CONSTRAINT ai_endpoints_api_key_hint_check
    CHECK (api_key_hint IS NULL OR char_length(api_key_hint) <= 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_ai_endpoints_updated_at ON ai_endpoints;
CREATE TRIGGER update_ai_endpoints_updated_at
  BEFORE UPDATE ON ai_endpoints
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE ai_endpoints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_endpoints FROM anon, authenticated;
