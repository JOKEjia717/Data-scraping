-- 向后兼容：新增列均允许 NULL，旧 RPA 的 INSERT/SELECT 不需要修改。
-- 部署完成前保持 RPA_WORKER_DATABASE_RETRY_SCHEDULE_ENABLED=false。
ALTER TABLE rpa_task_execution
  ADD COLUMN next_retry_at datetime NULL COMMENT '新 Worker 下次允许领取时间' AFTER fail_num,
  ADD COLUMN last_error_code varchar(64) NULL COMMENT '最近一次稳定错误码' AFTER next_retry_at,
  ADD COLUMN last_error_at datetime NULL COMMENT '最近一次技术失败时间' AFTER last_error_code,
  ADD INDEX idx_rpa_execution_retry_schedule
    (status, task_status, deleted, next_retry_at, priority, create_time);
