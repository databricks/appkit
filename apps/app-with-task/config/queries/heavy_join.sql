-- Shuffle-join two 100M-row streams on a 4-char MD5 hash prefix
-- (65536 buckets). Empirically ~20s on a Small warehouse.
--
-- Duration target ~20s — picked so the warehouse finishes the
-- statement within the user's kill+redeploy+click roundtrip
-- (~30-40s on Databricks Apps). When the user clicks the second
-- time, the statement is already SUCCEEDED in the warehouse, so the
-- TaskFlow recovery path's `pollStatement(...)` returns instantly
-- with the cached result instead of waiting on a still-running job.
--
-- Measured on this warehouse:
--   RANGE(50M)  = 8s    (too short to kill after CHECKPOINT)
--   RANGE(100M) = 20s   ← demo sweet spot
--   RANGE(200M) = 240s  (super-linear; warehouse still running
--                        when user re-clicks, recovery blocks on poll)
-- Don't shrink `SUBSTR(..., 1, 4)` — narrower prefix is super-linear
-- in shuffle and will also push past the recovery window.
WITH big1 AS (
    SELECT id,
           MD5(CAST(id * 31 AS STRING)) AS k,
           RAND()                       AS v
    FROM RANGE(100000000)
),
big2 AS (
    SELECT id,
           MD5(CAST((id + 7) AS STRING)) AS k,
           RAND()                        AS v
    FROM RANGE(100000000)
)
SELECT
    SUBSTR(b1.k, 1, 4)                  AS bucket,
    COUNT(*)                            AS pair_count,
    AVG(b1.v + b2.v)                    AS avg_v,
    current_timestamp()                 AS cache_buster
FROM big1 b1
JOIN big2 b2 ON SUBSTR(b1.k, 1, 4) = SUBSTR(b2.k, 1, 4)
GROUP BY SUBSTR(b1.k, 1, 4)
ORDER BY pair_count DESC
LIMIT 100;
