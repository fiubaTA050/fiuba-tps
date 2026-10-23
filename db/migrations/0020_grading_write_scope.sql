-- The grading worker's scope is renamed to match the `<area>:<access>` form
-- of the classroom:read / classroom:write pair (lib/data/api-key-scopes.ts).
-- Data only. Apply after the code that understands `grading:write` is
-- deployed: the code before it checks for `grading`, and would turn every
-- worker key away. The new code accepts both names until this has run.
UPDATE "api_keys" SET "scopes" = array_replace("scopes", 'grading', 'grading:write') WHERE 'grading' = ANY("scopes");
