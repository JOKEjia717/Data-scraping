-- Phase 1 only: nullable protocol rollout. Review and run manually while producers/workers are stopped.
-- This file is intentionally idempotent and never changes a non-empty execution business_type.

SET @rpa_schema := DATABASE();
SET @rpa_add_business_type := (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @rpa_schema
        AND TABLE_NAME = 'rpa_task_execution'
        AND COLUMN_NAME = 'business_type'
    ),
    'SELECT 1',
    'ALTER TABLE rpa_task_execution ADD COLUMN business_type varchar(64) NULL COMMENT ''DIAGNOSIS/CONTENT_STYLE_MONITOR/ENTRY_MONITOR/ARTICLE_PROBE'' AFTER task_id'
  )
);
PREPARE rpa_add_business_type_stmt FROM @rpa_add_business_type;
EXECUTE rpa_add_business_type_stmt;
DEALLOCATE PREPARE rpa_add_business_type_stmt;

UPDATE rpa_task_execution AS e
INNER JOIN brand_rpa_dispatch_task AS d
  ON d.id = e.task_id
 AND d.deleted = 0
SET e.business_type = d.business_type
WHERE e.business_type IS NULL;

SET @rpa_add_business_queue_index := (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = @rpa_schema
        AND TABLE_NAME = 'rpa_task_execution'
        AND INDEX_NAME = 'idx_rpa_execution_business_queue'
    ),
    'SELECT 1',
    'CREATE INDEX idx_rpa_execution_business_queue ON rpa_task_execution (business_type, worker_provider, status, task_status, next_retry_at, priority, id)'
  )
);
PREPARE rpa_add_business_queue_index_stmt FROM @rpa_add_business_queue_index;
EXECUTE rpa_add_business_queue_index_stmt;
DEALLOCATE PREPARE rpa_add_business_queue_index_stmt;

-- Validation: all four result sets must be reviewed before enabling monitor claims.
SELECT COUNT(*) AS null_type_count
FROM rpa_task_execution
WHERE deleted = 0
  AND (business_type IS NULL OR TRIM(business_type) = '');

SELECT e.id, e.task_id, e.business_type AS execution_type, d.business_type AS dispatch_type
FROM rpa_task_execution AS e
INNER JOIN brand_rpa_dispatch_task AS d ON d.id = e.task_id
WHERE e.deleted = 0
  AND d.deleted = 0
  AND e.business_type IS NOT NULL
  AND e.business_type <> d.business_type;

SELECT e.id, e.task_id
FROM rpa_task_execution AS e
LEFT JOIN brand_rpa_dispatch_task AS d ON d.id = e.task_id AND d.deleted = 0
WHERE e.deleted = 0
  AND d.id IS NULL;

SELECT business_type, COUNT(*) AS execution_count
FROM rpa_task_execution
WHERE deleted = 0
GROUP BY business_type
HAVING business_type IS NULL
   OR TRIM(business_type) = ''
   OR business_type NOT IN (
     'DIAGNOSIS', 'CONTENT_STYLE_MONITOR', 'ENTRY_MONITOR', 'ARTICLE_PROBE'
   );

-- Do not add NOT NULL in this phase. A separate migration is required after null/orphan counts reach zero.
