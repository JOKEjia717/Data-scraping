import path from "node:path";
import { PLATFORM_IDS } from "./platformExecution.js";
import type {
  DeepThinkingUnsupportedPolicy,
  PlatformId,
  WebSearchPolicy
} from "./types.js";
import type { RpaWorkerType } from "./rpaTask.js";

export interface RpaWorkerConfig {
  deploymentEnvironment: "staging" | "production";
  allowProductionClaims: boolean;
  workerType: RpaWorkerType;
  workerId: string;
  cdpEndpoint: string;
  chromeProfileDirectory: string;
  logDirectory: string;
  evidenceDirectory: string;
  outboxDirectory: string;
  shutdownFile: string;
  outboxWriteRetryMs: number;
  metricsDirectory: string;
  metricsSnapshotIntervalMs: number;
  diskWarningFreeMb: number;
  diskStopFreeMb: number;
  logMaxFileMb: number;
  logRetentionDays: number;
  evidenceRetentionDays: number;
  platforms: PlatformId[];
  dryRun: boolean;
  healthCheckOnly: boolean;
  runOnce: boolean;
  recoverStale: boolean;
  maxTasks: number;
  maxAttempts: number;
  retryBackoffMs: number;
  retryJitterMs: number;
  databaseRetryScheduleEnabled: boolean;
  providerRoutingEnabled: boolean;
  workerProvider: string;
  grayBrandIds: string[];
  grayBusinessTaskIds: string[];
  grayPercentage: number;
  brandWindowSize: number;
  brandBarrierPlatforms: PlatformId[];
  pollIntervalMs: number;
  pollJitterMs: number;
  candidateLimit: number;
  heartbeatIntervalMs: number;
  staleAfterMs: number;
  watchdogStallMs: number;
  platformRecheckIntervalMs: number;
  platformReadyConfirmations: number;
  platformProcessRestartMs: number;
  questionTimeoutMs: number;
  browserReconnectAttempts: number;
  browserReconnectBackoffMs: number;
  taskIntervalMs: number;
  batchIntervalMs: number;
  technicalCooldownMs: number;
  rateLimitCooldownMs: number;
  leaseWaitMs: number;
  leasePollMs: number;
  crossProcessMinIntervalMs: number;
  resolveTitles: boolean;
  deepThinkingUnsupportedPolicy: DeepThinkingUnsupportedPolicy;
  /** ARTICLE_PROBE 会在任务映射层强制覆盖为 REQUIRED。 */
  webSearchPolicy: WebSearchPolicy;
  maxConversationDurationMs: number;
  maxConversationQuestions: number;
  /** 新业务默认关闭；这些配置只由 monitor 读取，diagnosis 不依赖。 */
  entryMonitorEnabled: boolean;
  entryMonitorGrayProjectIds: string[];
  entryMonitorProjectChunkSize: number;
  entryMonitorConversationMaxDurationMs: number;
  entryMonitorConversationMaxQuestions: number;
  entryMonitorTimezone: "Asia/Shanghai";
  /** 风格监测使用独立开关；context/会话合同未完成时必须保持 false。 */
  contentStyleMonitorEnabled: boolean;
  contentStyleMonitorGrayProjectIds: string[];
  /** ARTICLE_PROBE 仅为存量兼容，可在存量清零后单独关闭。 */
  articleProbeLegacyEnabled: boolean;
}

export function parseRpaWorkerConfig(
  workerType: RpaWorkerType,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): RpaWorkerConfig {
  const args = parseArgs(argv);
  const prefix = workerType === "diagnosis" ? "RPA_DIAGNOSIS" : "RPA_MONITOR";
  const role = workerType;
  const configured = (suffix: string): string | undefined =>
    args.get(toCliName(suffix)) ?? environment[`${prefix}_${suffix}`] ??
    environment[`RPA_WORKER_${suffix}`];
  const entryConfigured = (suffix: string): string | undefined =>
    args.get(`entry-monitor-${toCliName(suffix)}`) ?? environment[`ENTRY_MONITOR_${suffix}`];
  const contentStyleConfigured = (suffix: string): string | undefined =>
    args.get(`content-style-monitor-${toCliName(suffix)}`) ??
    environment[`CONTENT_STYLE_MONITOR_${suffix}`];
  const heartbeatIntervalMs = integer(
    configured("HEARTBEAT_MS") ?? "30000",
    "heartbeat-ms",
    1_000,
    300_000
  );
  const staleAfterMs = integer(
    configured("STALE_AFTER_MS") ?? "300000",
    "stale-after-ms",
    60_000,
    86_400_000
  );
  if (staleAfterMs < heartbeatIntervalMs * 3) {
    throw new Error("stale-after-ms 必须至少是 heartbeat-ms 的 3 倍。");
  }
  const maxTasks = integer(configured("MAX_TASKS") ?? "1", "max-tasks", 1, 100);
  const pollIntervalMs = integer(
    configured("POLL_INTERVAL_MS") ?? "10000",
    "poll-interval-ms",
    100,
    3_600_000
  );
  const candidateLimit = integer(
    configured("CANDIDATE_LIMIT") ?? String(Math.max(100, maxTasks * 10)),
    "candidate-limit",
    maxTasks,
    1_000
  );
  const defaultPort = workerType === "diagnosis" ? 9222 : 9223;
  const runtimeRoot = path.resolve(cwd, "rpa-runtime", role);
  const config: RpaWorkerConfig = {
    deploymentEnvironment: deploymentEnvironment(
      configured("ENVIRONMENT") ?? "staging"
    ),
    allowProductionClaims: booleanValue(
      configured("ALLOW_PRODUCTION_CLAIMS") ?? "false",
      "allow-production-claims"
    ),
    workerType,
    workerId: nonEmpty(configured("WORKER_ID") ?? `${role}-worker`, "worker-id"),
    cdpEndpoint: nonEmpty(
      configured("CDP_ENDPOINT") ?? `http://127.0.0.1:${defaultPort}`,
      "cdp-endpoint"
    ),
    chromeProfileDirectory: path.resolve(
      configured("CHROME_PROFILE") ?? path.join(cwd, ".chrome-profiles", role)
    ),
    logDirectory: path.resolve(configured("LOG_DIR") ?? path.join(runtimeRoot, "logs")),
    evidenceDirectory: path.resolve(
      configured("EVIDENCE_DIR") ?? path.join(runtimeRoot, "evidence")
    ),
    outboxDirectory: path.resolve(
      configured("OUTBOX_DIR") ?? path.join(runtimeRoot, "outbox")
    ),
    shutdownFile: path.resolve(
      configured("SHUTDOWN_FILE") ?? path.join(runtimeRoot, "stop.request")
    ),
    outboxWriteRetryMs: integer(
      configured("OUTBOX_WRITE_RETRY_MS") ?? "5000",
      "outbox-write-retry-ms",
      100,
      3_600_000
    ),
    metricsDirectory: path.resolve(
      configured("METRICS_DIR") ?? path.join(runtimeRoot, "metrics")
    ),
    metricsSnapshotIntervalMs: integer(
      configured("METRICS_INTERVAL_MS") ?? "15000",
      "metrics-interval-ms",
      1_000,
      3_600_000
    ),
    diskWarningFreeMb: integer(
      configured("DISK_WARNING_FREE_MB") ?? "5120",
      "disk-warning-free-mb",
      1,
      10_000_000
    ),
    diskStopFreeMb: integer(
      configured("DISK_STOP_FREE_MB") ?? "1024",
      "disk-stop-free-mb",
      1,
      10_000_000
    ),
    logMaxFileMb: integer(configured("LOG_MAX_FILE_MB") ?? "100", "log-max-file-mb", 1, 10_000),
    logRetentionDays: integer(configured("LOG_RETENTION_DAYS") ?? "14", "log-retention-days", 1, 3650),
    evidenceRetentionDays: integer(
      configured("EVIDENCE_RETENTION_DAYS") ?? "7",
      "evidence-retention-days",
      1,
      3650
    ),
    platforms: parsePlatforms(configured("PLATFORMS") ?? PLATFORM_IDS.join(",")),
    // 首次部署默认 dry-run；必须显式 --dry-run=false 才领取和操作页面。
    dryRun: booleanValue(configured("DRY_RUN") ?? "true", "dry-run"),
    healthCheckOnly: booleanValue(configured("HEALTH_CHECK") ?? "false", "health-check"),
    runOnce: booleanValue(configured("RUN_ONCE") ?? "false", "run-once"),
    recoverStale: booleanValue(configured("RECOVER_STALE") ?? "true", "recover-stale"),
    maxTasks,
    maxAttempts: integer(
      configured("MAX_ATTEMPTS") ?? "3",
      "max-attempts",
      1,
      100
    ),
    retryBackoffMs: integer(
      configured("RETRY_BACKOFF_MS") ?? "30000",
      "retry-backoff-ms",
      0,
      3_600_000
    ),
    retryJitterMs: integer(
      configured("RETRY_JITTER_MS") ?? "5000",
      "retry-jitter-ms",
      0,
      600_000
    ),
    // 只有部署向后兼容 migration 后才开启，避免旧库因缺列而停止领取。
    databaseRetryScheduleEnabled: booleanValue(
      configured("DATABASE_RETRY_SCHEDULE_ENABLED") ?? "false",
      "database-retry-schedule-enabled"
    ),
    providerRoutingEnabled: booleanValue(
      configured("PROVIDER_ROUTING_ENABLED") ?? "false",
      "provider-routing-enabled"
    ),
    workerProvider: safeProvider(configured("PROVIDER") ?? "NEW_RPA"),
    grayBrandIds: csvIds(configured("GRAY_BRAND_IDS")),
    grayBusinessTaskIds: csvIds(configured("GRAY_BUSINESS_TASK_IDS")),
    grayPercentage: integer(
      configured("GRAY_PERCENTAGE") ?? "100",
      "gray-percentage",
      0,
      100
    ),
    brandWindowSize: integer(
      configured("BRAND_WINDOW_SIZE") ?? (workerType === "diagnosis" ? "2" : "0"),
      "brand-window-size",
      0,
      10
    ),
    brandBarrierPlatforms: parsePlatforms(
      configured("BRAND_BARRIER_PLATFORMS") ?? PLATFORM_IDS.join(",")
    ),
    pollIntervalMs,
    pollJitterMs: integer(
      configured("POLL_JITTER_MS") ?? String(Math.min(1_000, Math.floor(pollIntervalMs / 5))),
      "poll-jitter-ms",
      0,
      pollIntervalMs
    ),
    candidateLimit,
    heartbeatIntervalMs,
    staleAfterMs,
    watchdogStallMs: integer(
      configured("WATCHDOG_STALL_MS") ?? "300000",
      "watchdog-stall-ms",
      60_000,
      3_600_000
    ),
    platformRecheckIntervalMs: integer(
      configured("PLATFORM_RECHECK_INTERVAL_MS") ?? "60000",
      "platform-recheck-interval-ms",
      10_000,
      3_600_000
    ),
    platformReadyConfirmations: integer(
      configured("PLATFORM_READY_CONFIRMATIONS") ?? "2",
      "platform-ready-confirmations",
      1,
      10
    ),
    platformProcessRestartMs: integer(
      configured("PLATFORM_PROCESS_RESTART_MS") ?? "5000",
      "platform-process-restart-ms",
      1_000,
      300_000
    ),
    questionTimeoutMs: integer(
      configured("QUESTION_TIMEOUT_MS") ?? "180000",
      "question-timeout-ms",
      10_000,
      900_000
    ),
    browserReconnectAttempts: integer(
      configured("BROWSER_RECONNECT_ATTEMPTS") ?? "3",
      "browser-reconnect-attempts",
      1,
      20
    ),
    browserReconnectBackoffMs: integer(
      configured("BROWSER_RECONNECT_BACKOFF_MS") ?? "2000",
      "browser-reconnect-backoff-ms",
      100,
      300_000
    ),
    taskIntervalMs: integer(
      configured("TASK_INTERVAL_MS") ?? "5000",
      "task-interval-ms",
      0,
      600_000
    ),
    batchIntervalMs: integer(
      configured("BATCH_INTERVAL_MS") ?? "15000",
      "batch-interval-ms",
      0,
      3_600_000
    ),
    technicalCooldownMs: integer(
      configured("TECHNICAL_COOLDOWN_MS") ?? "60000",
      "technical-cooldown-ms",
      1_000,
      3_600_000
    ),
    rateLimitCooldownMs: integer(
      configured("RATE_LIMIT_COOLDOWN_MS") ?? "900000",
      "rate-limit-cooldown-ms",
      60_000,
      86_400_000
    ),
    leaseWaitMs: integer(
      configured("LEASE_WAIT_MS") ?? "120000",
      "lease-wait-ms",
      0,
      3_600_000
    ),
    leasePollMs: integer(
      configured("LEASE_POLL_MS") ?? "2000",
      "lease-poll-ms",
      100,
      60_000
    ),
    crossProcessMinIntervalMs: integer(
      configured("PLATFORM_MIN_INTERVAL_MS") ?? "10000",
      "platform-min-interval-ms",
      0,
      600_000
    ),
    resolveTitles: booleanValue(configured("RESOLVE_TITLES") ?? "true", "resolve-titles"),
    deepThinkingUnsupportedPolicy: deepThinkingUnsupportedPolicy(
      configured("DEEP_THINKING_UNSUPPORTED_POLICY") ?? "fail"
    ),
    webSearchPolicy: webSearchPolicy(
      configured("WEB_SEARCH_POLICY") ?? (workerType === "monitor" ? "REQUIRED" : "PREFERRED")
    ),
    maxConversationDurationMs: integer(
      configured("MAX_CONVERSATION_MS") ?? "3600000",
      "max-conversation-ms",
      60_000,
      86_400_000
    ),
    maxConversationQuestions: integer(
      configured("MAX_CONVERSATION_QUESTIONS") ?? "100",
      "max-conversation-questions",
      2,
      10_000
    ),
    entryMonitorEnabled: workerType === "monitor"
      ? booleanValue(entryConfigured("ENABLED") ?? "false", "entry-monitor-enabled")
      : false,
    entryMonitorGrayProjectIds: workerType === "monitor"
      ? csvIds(entryConfigured("GRAY_PROJECT_IDS"))
      : [],
    entryMonitorProjectChunkSize: workerType === "monitor"
      ? integer(
        entryConfigured("PROJECT_CHUNK_SIZE") ?? "5",
        "entry-monitor-project-chunk-size",
        1,
        1_000
      )
      : 5,
    entryMonitorConversationMaxDurationMs: workerType === "monitor"
      ? integer(
        entryConfigured("CONVERSATION_MAX_DURATION_MS") ?? "86400000",
        "entry-monitor-conversation-max-duration-ms",
        60_000,
        86_400_000
      )
      : 86_400_000,
    entryMonitorConversationMaxQuestions: workerType === "monitor"
      ? integer(
        entryConfigured("CONVERSATION_MAX_QUESTIONS") ?? "10000",
        "entry-monitor-conversation-max-questions",
        2,
        10_000
      )
      : 10_000,
    entryMonitorTimezone: workerType === "monitor"
      ? entryMonitorTimezone(entryConfigured("TIMEZONE") ?? "Asia/Shanghai")
      : "Asia/Shanghai",
    contentStyleMonitorEnabled: workerType === "monitor"
      ? booleanValue(
        contentStyleConfigured("ENABLED") ?? "false",
        "content-style-monitor-enabled"
      )
      : false,
    contentStyleMonitorGrayProjectIds: workerType === "monitor"
      ? csvIds(contentStyleConfigured("GRAY_PROJECT_IDS"))
      : [],
    articleProbeLegacyEnabled: workerType === "monitor"
      ? booleanValue(
        args.get("article-probe-legacy-enabled") ??
          environment.ARTICLE_PROBE_LEGACY_ENABLED ?? "true",
        "article-probe-legacy-enabled"
      )
      : false
  };
  if (config.diskWarningFreeMb < config.diskStopFreeMb) {
    throw new Error("disk-warning-free-mb 不能小于 disk-stop-free-mb。");
  }
  if (config.entryMonitorEnabled) {
    if (!config.providerRoutingEnabled) {
      throw new Error("启用 ENTRY_MONITOR 前必须开启 provider-routing-enabled。");
    }
    if (config.entryMonitorGrayProjectIds.length === 0) {
      throw new Error("启用 ENTRY_MONITOR 时必须配置灰度项目白名单。");
    }
  }
  if (config.contentStyleMonitorEnabled) {
    if (!config.providerRoutingEnabled) {
      throw new Error("启用 CONTENT_STYLE_MONITOR 前必须开启 provider-routing-enabled。");
    }
    if (config.contentStyleMonitorGrayProjectIds.length === 0) {
      throw new Error("启用 CONTENT_STYLE_MONITOR 时必须配置灰度项目白名单。");
    }
    throw new Error(
      "CONTENT_STYLE_MONITOR 的通用 execution context 尚未完成，当前版本禁止领取。"
    );
  }
  if (
    config.deploymentEnvironment === "production" &&
    !config.dryRun &&
    !config.allowProductionClaims
  ) {
    throw new Error(
      "production 环境领取任务必须显式设置 RPA_WORKER_ALLOW_PRODUCTION_CLAIMS=true。"
    );
  }
  validateDistinctWorkerResources(config, environment);
  return config;
}

function deploymentEnvironment(value: string): "staging" | "production" {
  if (value === "staging" || value === "production") return value;
  throw new Error("environment 只能是 staging 或 production。");
}

function safeProvider(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(normalized)) {
    throw new Error("provider 必须是 2-32 位大写字母、数字或下划线。");
  }
  return normalized;
}

function csvIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (values.some((item) => !/^\d+$/.test(item))) {
    throw new Error("灰度 ID 白名单只能包含逗号分隔的数字 ID。");
  }
  return values;
}

function deepThinkingUnsupportedPolicy(value: string): DeepThinkingUnsupportedPolicy {
  if (value === "fail" || value === "allow_degrade") return value;
  throw new Error(
    "deep-thinking-unsupported-policy 只能是 fail 或 allow_degrade。"
  );
}

function webSearchPolicy(value: string): WebSearchPolicy {
  const normalized = value.trim().toUpperCase();
  if (normalized === "REQUIRED" || normalized === "PREFERRED" || normalized === "DISABLED") {
    return normalized;
  }
  throw new Error("web-search-policy 只能是 REQUIRED、PREFERRED 或 DISABLED。");
}

function entryMonitorTimezone(value: string): "Asia/Shanghai" {
  if (value === "Asia/Shanghai") return value;
  throw new Error("entry-monitor-timezone 目前只允许 Asia/Shanghai。");
}

function validateDistinctWorkerResources(
  config: RpaWorkerConfig,
  environment: NodeJS.ProcessEnv
): void {
  const otherPrefix = config.workerType === "diagnosis" ? "RPA_MONITOR" : "RPA_DIAGNOSIS";
  const otherWorkerId = environment[`${otherPrefix}_WORKER_ID`]?.trim();
  if (otherWorkerId && otherWorkerId === config.workerId) {
    throw new Error("diagnosis 与 monitor 的 workerId 不能相同。");
  }
  const otherEndpoint = environment[`${otherPrefix}_CDP_ENDPOINT`]?.trim();
  if (otherEndpoint && otherEndpoint === config.cdpEndpoint) {
    throw new Error("diagnosis 与 monitor 的 CDP endpoint 不能相同。");
  }
  const otherProfile = environment[`${otherPrefix}_CHROME_PROFILE`]?.trim();
  if (
    otherProfile &&
    path.resolve(otherProfile) === config.chromeProfileDirectory
  ) {
    throw new Error("diagnosis 与 monitor 的 Chrome Profile 不能相同。");
  }
  const otherOutbox = environment[`${otherPrefix}_OUTBOX_DIR`]?.trim();
  if (otherOutbox && path.resolve(otherOutbox) === config.outboxDirectory) {
    throw new Error("diagnosis 与 monitor 的 Result Outbox 目录不能相同。");
  }
  const otherMetrics = environment[`${otherPrefix}_METRICS_DIR`]?.trim();
  if (otherMetrics && path.resolve(otherMetrics) === config.metricsDirectory) {
    throw new Error("diagnosis 与 monitor 的指标目录不能相同。");
  }
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (const item of argv) {
    if (!item.startsWith("--")) throw new Error(`未知参数格式：${item}`);
    const [key, ...value] = item.slice(2).split("=");
    args.set(key, value.join("=") || "true");
  }
  return args;
}

function toCliName(suffix: string): string {
  return suffix.toLowerCase().replace(/_/g, "-");
}

function parsePlatforms(value: string): PlatformId[] {
  const platforms = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (platforms.length === 0) throw new Error("platforms 至少包含一个平台。");
  for (const platform of platforms) {
    if (!(PLATFORM_IDS as readonly string[]).includes(platform)) {
      throw new Error(`不支持的平台：${platform}`);
    }
  }
  return platforms as PlatformId[];
}

function integer(
  value: string,
  field: string,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} 必须是 ${minimum} 到 ${maximum} 的整数。`);
  }
  return parsed;
}

function booleanValue(value: string, field: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${field} 只能是 true 或 false。`);
}

function nonEmpty(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} 不能为空。`);
  return value.trim();
}
