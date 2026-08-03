-- 回滚前：停止新 Worker并清空 Result Outbox；恢复旧 RPA 前确认待处理任务可重新领取。
ALTER TABLE rpa_task_execution
  DROP INDEX idx_execution_worker_provider,
  DROP COLUMN worker_provider;

ALTER TABLE brand_rpa_dispatch_task
  DROP INDEX idx_dispatch_worker_provider,
  DROP COLUMN worker_provider;
