-- 前置条件：旧 RPA 已停止；新 Worker 仍处于 dry-run。
ALTER TABLE brand_rpa_dispatch_task
  ALTER COLUMN worker_provider SET DEFAULT 'NEW_RPA';
ALTER TABLE rpa_task_execution
  ALTER COLUMN worker_provider SET DEFAULT 'NEW_RPA';
UPDATE brand_rpa_dispatch_task SET worker_provider = 'NEW_RPA'
WHERE deleted = 0 AND status = 'DISPATCHED';
UPDATE rpa_task_execution SET worker_provider = 'NEW_RPA'
WHERE deleted = 0 AND status = 0 AND task_status = 0 AND answer_id IS NULL;
