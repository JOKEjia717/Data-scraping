-- Manual rollback only. Stop every Java producer and Worker that reads/writes execution.business_type first.
SET @rpa_schema := DATABASE();

SET @rpa_drop_business_queue_index := (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = @rpa_schema
        AND TABLE_NAME = 'rpa_task_execution'
        AND INDEX_NAME = 'idx_rpa_execution_business_queue'
    ),
    'DROP INDEX idx_rpa_execution_business_queue ON rpa_task_execution',
    'SELECT 1'
  )
);
PREPARE rpa_drop_business_queue_index_stmt FROM @rpa_drop_business_queue_index;
EXECUTE rpa_drop_business_queue_index_stmt;
DEALLOCATE PREPARE rpa_drop_business_queue_index_stmt;

SET @rpa_drop_business_type := (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @rpa_schema
        AND TABLE_NAME = 'rpa_task_execution'
        AND COLUMN_NAME = 'business_type'
    ),
    'ALTER TABLE rpa_task_execution DROP COLUMN business_type',
    'SELECT 1'
  )
);
PREPARE rpa_drop_business_type_stmt FROM @rpa_drop_business_type;
EXECUTE rpa_drop_business_type_stmt;
DEALLOCATE PREPARE rpa_drop_business_type_stmt;
