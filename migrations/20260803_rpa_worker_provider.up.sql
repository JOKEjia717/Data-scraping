-- 第一阶段只增加兼容字段，不改变任务领取方。
ALTER TABLE brand_rpa_dispatch_task
  ADD COLUMN worker_provider varchar(32) NOT NULL DEFAULT 'LEGACY'
    COMMENT 'LEGACY/NEW_RPA；灰度领取路由' AFTER status,
  ADD INDEX idx_dispatch_worker_provider
    (business_type, worker_provider, status, deleted, create_time);

ALTER TABLE rpa_task_execution
  ADD COLUMN worker_provider varchar(32) NOT NULL DEFAULT 'LEGACY'
    COMMENT '必须与 dispatch.worker_provider 一致' AFTER task_id,
  ADD INDEX idx_execution_worker_provider
    (worker_provider, status, task_status, deleted, priority, create_time);

-- 全量切换另行执行 20260803_rpa_worker_cutover_to_new.sql。
