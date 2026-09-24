-- Drops the jsonb market_hours table (issue #13) once pair_hours holds every stored hour.
-- Refuses while any digest's market count differs from its pair_hours rows; run `npm run rebuild` first.

DO $$
DECLARE
  incomplete integer;
BEGIN
  SELECT count(*) INTO incomplete
  FROM raw_digests d
  LEFT JOIN (
    SELECT l.realm, h.source_hour, count(*) AS n
    FROM pair_hours h JOIN leagues l ON l.id = h.league_id
    GROUP BY l.realm, h.source_hour
  ) c ON c.realm = d.realm AND c.source_hour = d.source_hour
  WHERE coalesce(c.n, 0) <> d.market_count;

  IF incomplete > 0 THEN
    RAISE EXCEPTION '% stored hours are not fully rebuilt into pair_hours; run npm run rebuild, then migrate again', incomplete;
  END IF;
END $$;

DROP TABLE market_hours;
