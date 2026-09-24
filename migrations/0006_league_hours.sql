-- Markets per league and parsed hour (issue #5). Classifying an hour needs to know whether its league was present,
-- and counting that from pair_hours reads every row of the league (0.7 s for 30 days). Parse fills it with each hour.
CREATE TABLE league_hours (
  league_id integer NOT NULL REFERENCES leagues (id),
  source_hour timestamptz NOT NULL,
  markets integer NOT NULL CHECK (markets > 0),
  PRIMARY KEY (league_id, source_hour)
);

INSERT INTO league_hours (league_id, source_hour, markets)
SELECT league_id, source_hour, count(*) FROM pair_hours GROUP BY league_id, source_hour;
