-- Gives a short key to the invitations created before 0007 added the column.
--
-- The original did not backfill (20170525221134 only adds the column and the
-- index), which is why `InvitationHelper#invitation_key` falls back to the long
-- key forever on those rows. That made sense there — millions of links were
-- already in the wild. Here the rows predating the column are a handful, none
-- of them shared outside the cátedra, and a teacher looking at two assignments
-- side by side should not see two different link formats.
--
-- Eight url-safe base64 characters, the shape of `SecureRandom.urlsafe_base64(6)`,
-- built out of `gen_random_uuid()`: its 16 bytes are re-encoded as base64, the
-- two characters base64url spells differently are translated, and the first
-- eight are taken — 48 bits, the same as the generator in
-- lib/data/assignment-fields.ts. Not `gen_random_bytes`, which would read
-- better and was the first attempt: it lives in pgcrypto, and the test database
-- is a PGlite that does not load it, so the whole suite failed on this file.
-- `gen_random_uuid` is core since Postgres 13 and works in both.
--
-- The fallback in `invitationUrl` stays: it is what keeps a row whose key
-- somehow never got written from rendering a broken link.

UPDATE "assignment_invitations"
SET "short_key" = substr(
  translate(
    encode(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
    '+/',
    '-_'
  ),
  1,
  8
)
WHERE "short_key" IS NULL;
--> statement-breakpoint
UPDATE "group_assignment_invitations"
SET "short_key" = substr(
  translate(
    encode(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
    '+/',
    '-_'
  ),
  1,
  8
)
WHERE "short_key" IS NULL;
