-- Hash + COUNT(DISTINCT) over 500M synthetic rows.
-- `MD5` is row-by-row CPU; `COUNT(DISTINCT)` forces a shuffle that
-- Photon can't shortcut. Result cache is defeated by
-- `current_timestamp()` in the projection. Reliably 30-90s on a Small
-- warehouse — a wide-enough window to kill the Node process between
-- `CHECKPOINT PERSISTED` and final completion.
WITH src AS (
    SELECT
        id,
        MD5(CAST(id           AS STRING)) AS h1,
        MD5(CAST(id * 31      AS STRING)) AS h2
    FROM RANGE(500000000)
)
SELECT
    SUBSTR(h1, 1, 4)        AS bucket,
    COUNT(DISTINCT h2)      AS unique_h2,
    COUNT(*)                AS total,
    current_timestamp()     AS cache_buster
FROM src
GROUP BY SUBSTR(h1, 1, 4)
ORDER BY unique_h2 DESC
LIMIT 100;
