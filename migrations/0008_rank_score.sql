-- Calculation version 2 ranks markets by (high − low) / low × Chaos traded per covered hour instead of by Chaos
-- traded alone. The score is stored so readers can show and sort by it; activity_rank now orders eligible markets by it.
ALTER TABLE market_metrics ADD COLUMN rank_score double precision;
