-- Historical migration marker.
--
-- This version already exists in the production migration history.
-- Its resulting schema is consolidated into the foundational baseline
-- migrations dated 20260620000000 through 20260620000005.
--
-- This marker preserves local/remote migration-history alignment and is
-- intentionally a no-op during fresh environment replay.

select 1;
