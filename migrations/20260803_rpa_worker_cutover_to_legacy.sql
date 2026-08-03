-- 回退前：停止新 Worker并清空 Outbox；确认旧 RPA 可以恢复领取。
ALTER TABLE brand_rpa_dispatch_task
  ALTER COLUMN worker_provider SET DEFAULT 'LEGACY';
ALTER TABLE rpa_task_execution
  ALTER COLUMN worker_provider SET DEFAULT 'LEGACY';
UPDATE brand_rpa_dispatch_task SET worker_provider = 'LEGACY'
WHERE deleted = 0 AND status = 'DISPATCHED';
UPDATE rpa_task_execution SET worker_provider = 'LEGACY', next_retry_at = NULL
WHERE deleted = 0 AND status = 0 AND task_status = 0 AND answer_id IS NULL;
