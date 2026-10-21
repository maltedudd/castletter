-- NIAS-62: optional fallback endpoint per purpose. A second row with slot 'fallback' is tried
-- when the primary endpoint of that purpose fails (src/lib/ai/fallback.mjs). Existing rows
-- become 'primary'; without a fallback row nothing changes.
--
-- Run right before merging the code: the previous worker keeps resolving its endpoints (only
-- 'primary' rows exist until the new admin area writes a fallback), but the previous admin
-- area can no longer save (its upsert conflicts on purpose alone) until the new code is live.
--
-- The fallback key is encrypted with the purpose plus ':fallback' as authenticated data, so a
-- ciphertext cannot be copied between slots. Existing data is not changed apart from the
-- default slot. Idempotent: safe to run twice.

ALTER TABLE ai_endpoints ADD COLUMN IF NOT EXISTS slot TEXT NOT NULL DEFAULT 'primary';

ALTER TABLE ai_endpoints DROP CONSTRAINT IF EXISTS ai_endpoints_slot_check;
ALTER TABLE ai_endpoints ADD CONSTRAINT ai_endpoints_slot_check CHECK (slot IN ('primary', 'fallback'));

-- One endpoint per purpose and slot.
ALTER TABLE ai_endpoints DROP CONSTRAINT IF EXISTS ai_endpoints_pkey;
ALTER TABLE ai_endpoints ADD CONSTRAINT ai_endpoints_pkey PRIMARY KEY (purpose, slot);
