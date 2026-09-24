-- Fetch stores raw digests only; npm run parse turns them into pair_hours later (issue #15).
-- parser_version now records which parser filled pair_hours from the digest. NULL means not parsed yet.
-- Digests stored before this migration are already parsed (0003 checked every hour), so they keep their version.
ALTER TABLE raw_digests ALTER COLUMN parser_version DROP NOT NULL;

-- Validation problems from the last parse attempt; the digest stays pending until a parser accepts it.
ALTER TABLE raw_digests ADD COLUMN parse_error text;
