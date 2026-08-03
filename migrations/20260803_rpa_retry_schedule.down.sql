-- 回滚前必须先关闭 RPA_WORKER_DATABASE_RETRY_SCHEDULE_ENABLED 并安全停止新 Worker。
ALTER TABLE rpa_task_execution
  DROP INDEX idx_rpa_execution_retry_schedule,
  DROP COLUMN last_error_at,
  DROP COLUMN last_error_code,
  DROP COLUMN next_retry_at;
