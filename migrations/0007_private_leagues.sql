-- Private leagues are named "<name> (PL<number>)" by the game; 2,002 of the first 2,034 stored leagues were private.
-- Their history stays stored, but metrics and the read API cover public leagues only.
ALTER TABLE leagues ADD COLUMN private boolean GENERATED ALWAYS AS (name ~ '\(PL[0-9]+\)$') STORED;
