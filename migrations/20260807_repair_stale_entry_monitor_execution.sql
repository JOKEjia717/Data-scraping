-- Repair the four stale ENTRY_MONITOR executions left pending after their Java
-- parent task and samples timed out. This script never deletes data and is
-- idempotent: after a successful run the guarded UPDATE affects zero rows.
--
-- SAFE DEFAULT: no rows are updated unless the operator explicitly runs:
--   SET @apply_entry_monitor_repair = 1;
-- in the same MySQL session before sourcing this file.
--
-- Scope:
--   probe_article_task.id = 49
--   dispatch_task_id = 2085351936934309889
--   sample ids = 604, 605, 606, 607
--   execution ids = 1293, 1294, 1295, 1296

SET @apply_entry_monitor_repair = COALESCE(@apply_entry_monitor_repair, 0);
SET @repair_probe_task_id = 49;
SET @repair_dispatch_task_id = 2085351936934309889;

-- Preflight: inspect the exact business, sample, dispatch, execution and answer state.
SELECT
  pat.id AS probe_task_id,
  pat.status AS probe_task_status,
  pat.monitor_date AS probe_task_monitor_date,
  pas.id AS sample_id,
  pas.status AS sample_status,
  pas.monitor_date AS sample_monitor_date,
  pas.rpa_execution_id AS execution_id,
  e.status AS execution_status,
  e.task_status,
  e.answer_id,
  e.worker_provider,
  e.last_error_code,
  ctx.monitor_date AS context_monitor_date,
  d.business_type,
  d.business_task_id,
  COUNT(a.id) AS answer_row_count
FROM probe_article_task AS pat
INNER JOIN probe_article_sample AS pas
  ON pas.probe_task_id = pat.id
  AND pas.id IN (604, 605, 606, 607)
  AND pas.deleted = b'0'
INNER JOIN rpa_task_execution AS e
  ON e.id = pas.rpa_execution_id
  AND e.id IN (1293, 1294, 1295, 1296)
  AND e.deleted = 0
INNER JOIN brand_rpa_dispatch_task AS d
  ON d.id = e.task_id
  AND d.id = pat.dispatch_task_id
  AND d.deleted = b'0'
LEFT JOIN rpa_task_execution_context AS ctx
  ON ctx.execution_id = e.id
  AND ctx.deleted = b'0'
LEFT JOIN rpa_answer AS a
  ON a.execution_id = e.id
WHERE pat.id = @repair_probe_task_id
  AND pat.deleted = b'0'
GROUP BY
  pat.id, pat.status, pat.monitor_date,
  pas.id, pas.status, pas.monitor_date, pas.rpa_execution_id,
  e.status, e.task_status, e.answer_id, e.worker_provider, e.last_error_code,
  ctx.monitor_date, d.business_type, d.business_task_id
ORDER BY e.id;

START TRANSACTION;

-- Lock the complete repair scope before evaluating the guard. This prevents a
-- Worker claim or Java timeout reconciliation from racing the all-or-none check.
SELECT id, status, dispatch_task_id
FROM probe_article_task
WHERE id = @repair_probe_task_id
FOR UPDATE;

SELECT id, status, rpa_execution_id
FROM probe_article_sample
WHERE id IN (604, 605, 606, 607)
ORDER BY id
FOR UPDATE;

SELECT id, status, task_status, answer_id
FROM rpa_task_execution
WHERE id IN (1293, 1294, 1295, 1296)
ORDER BY id
FOR UPDATE;

SELECT id, status, business_type, business_task_id
FROM brand_rpa_dispatch_task
WHERE id = @repair_dispatch_task_id
FOR UPDATE;

-- All four rows must still match every approved precondition. A partial match
-- intentionally makes the UPDATE a no-op instead of partially repairing a batch.
SELECT COUNT(*) INTO @eligible_execution_count
FROM rpa_task_execution AS e
INNER JOIN brand_rpa_dispatch_task AS d
  ON d.id = e.task_id
  AND d.id = @repair_dispatch_task_id
  AND d.business_type = 'ENTRY_MONITOR'
  AND d.business_task_id = @repair_probe_task_id
  AND d.deleted = b'0'
INNER JOIN probe_article_task AS pat
  ON pat.id = d.business_task_id
  AND pat.id = @repair_probe_task_id
  AND pat.dispatch_task_id = d.id
  AND pat.status = 'TIMEOUT'
  AND pat.deleted = b'0'
INNER JOIN probe_article_sample AS pas
  ON pas.probe_task_id = pat.id
  AND pas.rpa_execution_id = e.id
  AND pas.id IN (604, 605, 606, 607)
  AND pas.status = 'TIMEOUT'
  AND pas.deleted = b'0'
WHERE e.id IN (1293, 1294, 1295, 1296)
  AND e.status = 0
  AND e.task_status = 0
  AND e.answer_id IS NULL
  AND e.deleted = 0
  AND NOT EXISTS (
    SELECT 1
    FROM rpa_answer AS a
    WHERE a.execution_id = e.id
  );

SELECT
  @apply_entry_monitor_repair AS apply_requested,
  @eligible_execution_count AS eligible_execution_count,
  CASE
    WHEN @apply_entry_monitor_repair <> 1 THEN 'NO_OP_CONFIRMATION_REQUIRED'
    WHEN @eligible_execution_count <> 4 THEN 'NO_OP_PRECONDITION_FAILED'
    ELSE 'READY_TO_UPDATE'
  END AS repair_decision;

UPDATE rpa_task_execution AS e
INNER JOIN probe_article_sample AS pas
  ON pas.rpa_execution_id = e.id
  AND pas.probe_task_id = @repair_probe_task_id
  AND pas.id IN (604, 605, 606, 607)
  AND pas.status = 'TIMEOUT'
  AND pas.deleted = b'0'
SET
  e.status = 3,
  e.task_status = 3,
  e.task_end_time = CURRENT_TIMESTAMP,
  e.end_time = CURRENT_TIMESTAMP,
  e.last_error_code = 'DATE_WINDOW_EXPIRED',
  e.last_error_at = CURRENT_TIMESTAMP,
  e.modify_time = CURRENT_TIMESTAMP
WHERE @apply_entry_monitor_repair = 1
  AND @eligible_execution_count = 4
  AND e.task_id = @repair_dispatch_task_id
  AND e.id IN (1293, 1294, 1295, 1296)
  AND e.status = 0
  AND e.task_status = 0
  AND e.answer_id IS NULL
  AND e.deleted = 0
  AND NOT EXISTS (
    SELECT 1
    FROM rpa_answer AS a
    WHERE a.execution_id = e.id
  );

SET @repair_affected_rows = ROW_COUNT();

-- Postflight: a confirmed first run must report 4 affected rows and four 3/3
-- executions. A second run must report 0 affected rows.
SELECT @repair_affected_rows AS affected_rows;

SELECT
  e.id AS execution_id,
  e.status,
  e.task_status,
  e.answer_id,
  e.task_end_time,
  e.end_time,
  e.last_error_code,
  e.last_error_at
FROM rpa_task_execution AS e
WHERE e.id IN (1293, 1294, 1295, 1296)
ORDER BY e.id;

COMMIT;

-- Rollback guidance:
-- 1. Before COMMIT, use ROLLBACK instead of COMMIT if any result is unexpected.
-- 2. After COMMIT, do not automatically reopen these expired executions. Restore
--    from an audited backup only after confirming the Java parent/sample state.
-- 3. The correct operational follow-up is to create a new date-consistent DAILY
--    task, not to change task 49 or executions 1293-1296 back to pending.
