/**
 * AI 爬取运营台 — 后端 API 桥接服务
 *
 * 职责：
 *   1. 读取 .env 中的数据库配置（复用项目的 mysql2 连接约定）。
 *   2. 对主库（research 模式）和 RPA 库（diagnosis/monitor 模式）暴露只读 REST 端点。
 *   3. 读取 rpa-runtime 下的 worker-metrics.json，与数据库状态合并。
 *   4. 托管前端 dashboard/index.html（全内联，无外部依赖）。
 *
 * 安全：仪表板完全只读，绝不修改 rpa_task_execution / dispatch / answer 等表。
 *       数据库凭据只在服务端，前端永远拿不到。
 *
 * 运行：node dashboard/server.mjs   （建议从项目根目录启动，便于解析 node_modules）
 */

import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT ?? 8787);

/* ----------------------------- 平台映射工具 ----------------------------- */

const PLATFORM_NAMES = {
  doubao: "豆包",
  deepseek: "DeepSeek",
  qianwen: "千问",
  yuanbao: "元宝"
};
const PLATFORM_ORDER = ["doubao", "deepseek", "qianwen", "yuanbao"];

function resolvePlatform(aiModelId, aiModelName) {
  const id = String(aiModelId ?? "").trim();
  const name = String(aiModelName ?? "").toLowerCase();
  const byId = { "1": "doubao", "2": "deepseek", "3": "yuanbao", "4": "qianwen" };
  if (byId[id]) return byId[id];
  if (name.includes("doubao") || name.includes("豆包")) return "doubao";
  if (name.includes("deepseek")) return "deepseek";
  if (name.includes("yuanbao") || name.includes("元宝")) return "yuanbao";
  if (name.includes("qianwen") || name.includes("千问")) return "qianwen";
  return id || name || "unknown";
}

/* ----------------------------- 连接池（延迟创建） ----------------------------- */

let mainPool;
function getMainPool() {
  if (mainPool) return mainPool;
  if (!process.env.DB_USER || !process.env.DB_PASSWORD) return null;
  mainPool = mysql.createPool({
    host: process.env.DB_HOST?.trim() || "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME?.trim() || "Data_Scraping",
    connectionLimit: 4,
    waitForConnections: true,
    queueLimit: 20,
    connectTimeout: 8000,
    charset: "utf8mb4",
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true
  });
  return mainPool;
}

let rpaPool;
function getRpaPool() {
  if (rpaPool) return rpaPool;
  if (!process.env.RPA_DB_NAME || !process.env.RPA_DB_USER || !process.env.RPA_DB_PASSWORD) {
    return null;
  }
  rpaPool = mysql.createPool({
    host: process.env.RPA_DB_HOST?.trim() || "127.0.0.1",
    port: Number(process.env.RPA_DB_PORT ?? 3306),
    user: process.env.RPA_DB_USER,
    password: process.env.RPA_DB_PASSWORD,
    database: process.env.RPA_DB_NAME,
    connectionLimit: 4,
    waitForConnections: true,
    queueLimit: 20,
    connectTimeout: 8000,
    charset: "utf8mb4",
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true
  });
  return rpaPool;
}

/** 统一查询封装：单条查询失败不影响其它端点。 */
async function queryDb(pool, sql, params = []) {
  if (!pool) return null;
  const [rows] = await pool.query(sql, params);
  return rows;
}

/* ----------------------------- 指标文件读取 ----------------------------- */

function readMetricsFile(workerType) {
  const envKey = workerType === "monitor" ? "RPA_MONITOR_METRICS_DIR" : "RPA_DIAGNOSIS_METRICS_DIR";
  const dir = process.env[envKey]?.trim()
    || path.join(__dirname, "..", "rpa-runtime", workerType, "metrics");
  const file = path.join(dir, "worker-metrics.json");
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 研究爬取结果以文件形式存于 results/，此处读取供前端展示（DB 无研究表时回退）。 */
const RESEARCH_PLATFORMS = [
  { code: "doubao", name: "豆包" },
  { code: "deepseek", name: "DeepSeek" },
  { code: "qianwen", name: "千问" },
  { code: "yuanbao", name: "元宝" }
];
function readResearchFiles() {
  const dir = path.join(__dirname, "..", "results");
  if (!fs.existsSync(dir)) return { available: false, answers: [], references: [] };
  const answers = [];
  const references = [];
  const nameToCode = Object.fromEntries(RESEARCH_PLATFORMS.map(p => [p.name, p.code]));

  for (const p of RESEARCH_PLATFORMS) {
    const f = path.join(dir, p.code, "answers.json");
    try {
      if (fs.existsSync(f)) {
        const arr = JSON.parse(fs.readFileSync(f, "utf8"));
        for (const a of arr) answers.push({ ...a, platformCode: p.code, platformName: p.name });
      }
    } catch { /* 忽略损坏文件 */ }
  }

  const rf = path.join(dir, "references.json");
  try {
    if (fs.existsSync(rf)) {
      const grouped = JSON.parse(fs.readFileSync(rf, "utf8"));
      for (const node of grouped) {
        for (const [pname, refs] of Object.entries(node.platforms || {})) {
          const code = nameToCode[pname] || pname;
          for (const r of refs || []) {
            references.push({
              question: node.question, platformCode: code, platformName: pname,
              rank: r.rank, articlePlatform: r.articlePlatform, articleTime: r.articleTime,
              title: r.title, summary: r.summary, url: r.url, extractedAt: r.extractedAt
            });
          }
        }
      }
    }
  } catch { /* 忽略 */ }

  return { available: true, answers, references };
}

/* ----------------------------- 端点实现 ----------------------------- */

async function overviewHandler() {
  const result = { generatedAt: new Date().toISOString() };

  // RPA 各平台任务状态（按 business_type × 平台聚合）
  const rpa = getRpaPool();
  if (rpa) {
    const rows = await queryDb(
      rpa,
      `SELECT
         d.business_type AS businessType,
         e.ai_model_id AS aiModelId,
         e.ai_model_name AS aiModelName,
         SUM(CASE WHEN e.status = 0 AND e.task_status = 0 THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN e.status = 1 AND e.task_status = 1 THEN 1 ELSE 0 END) AS processing,
         SUM(CASE WHEN e.status = 2 AND e.task_status = 2 THEN 1 ELSE 0 END) AS succeeded,
         SUM(CASE WHEN e.status = 3 AND e.task_status = 3 THEN 1 ELSE 0 END) AS finalFailed
       FROM rpa_task_execution e
       JOIN brand_rpa_dispatch_task d ON d.id = e.task_id AND d.deleted = 0
       WHERE e.deleted = 0
       GROUP BY d.business_type, e.ai_model_id, e.ai_model_name`
    );
    const byPlatform = {};
    let totals = { pending: 0, processing: 0, succeeded: 0, finalFailed: 0 };
    for (const r of rows || []) {
      const platform = resolvePlatform(r.aiModelId, r.aiModelName);
      const cell = byPlatform[platform] || (byPlatform[platform] = {
        pending: 0, processing: 0, succeeded: 0, finalFailed: 0, business: {}
      });
      const v = {
        pending: Number(r.pending), processing: Number(r.processing),
        succeeded: Number(r.succeeded), finalFailed: Number(r.finalFailed)
      };
      cell.pending += v.pending;
      cell.processing += v.processing;
      cell.succeeded += v.succeeded;
      cell.finalFailed += v.finalFailed;
      cell.business[r.businessType] = v;
      totals.pending += v.pending;
      totals.processing += v.processing;
      totals.succeeded += v.succeeded;
      totals.finalFailed += v.finalFailed;
    }
    result.rpa = { enabled: true, byPlatform, totals };
  } else {
    result.rpa = { enabled: false, byPlatform: {}, totals: null };
  }

  // research 模式状态（研究表可能未入库，需容错）
  const main = getMainPool();
  if (main) {
    try {
      const taskRows = await queryDb(
        main,
        `SELECT t.status, p.code AS platformCode, COUNT(*) AS count
         FROM question_platform_tasks t
         JOIN platforms p ON p.id = t.platform_id
         GROUP BY t.status, p.code`
      );
      const byPlatform = {};
      const states = { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0 };
      for (const r of taskRows || []) {
        const platform = String(r.platformCode);
        const cell = byPlatform[platform] || (byPlatform[platform] = {});
        cell[r.status] = Number(r.count);
        states[r.status] = (states[r.status] || 0) + Number(r.count);
      }
      const runs = await queryDb(
        main,
        `SELECT id, status, started_at AS startedAt, completed_at AS completedAt, error_message AS errorMessage
         FROM crawl_runs ORDER BY started_at DESC LIMIT 10`
      );
      result.research = { enabled: true, byPlatform, states, runs: runs || [] };
    } catch (e) {
      // 研究表不存在：标记 unavailable，前端回退到 results/ 文件
      result.research = { enabled: false, unavailable: true, reason: String(e?.message || e) };
    }
  } else {
    result.research = { enabled: false };
  }

  // metrics 健康状态（合并 diagnosis + monitor）
  const metrics = { diagnosis: readMetricsFile("diagnosis"), monitor: readMetricsFile("monitor") };
  result.metrics = metrics;

  return result;
}

async function rpaTasksHandler(url) {
  const pool = getRpaPool();
  if (!pool) return { enabled: false, rows: [] };
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const state = url.searchParams.get("state");
  const businessType = url.searchParams.get("businessType");
  let where = "e.deleted = 0";
  const params = [];
  if (state && ["0", "1", "2", "3"].includes(state)) {
    where += " AND e.status = ? AND e.task_status = ?";
    params.push(Number(state), Number(state));
  }
  if (businessType) {
    where += " AND d.business_type = ?";
    params.push(businessType);
  }
  const rows = await queryDb(
    pool,
    `SELECT
       e.id AS executionId,
       d.business_type AS businessType,
       e.keyword,
       e.ai_model_id AS aiModelId,
       e.ai_model_name AS aiModelName,
       e.status,
       e.task_status AS taskStatus,
       e.answer_id AS answerId,
       e.fail_num AS failCount,
       e.create_time AS createdAt,
       e.modify_time AS modifyTime,
       e.start_time AS startTime,
       e.last_error_code AS lastErrorCode,
       db2.t1_brand AS brandName,
       db2.t1_product AS brandProduct,
       db2.t1_industry AS brandIndustry
     FROM rpa_task_execution e
     JOIN brand_rpa_dispatch_task d ON d.id = e.task_id AND d.deleted = 0
     LEFT JOIN (
       SELECT diagnosis_task_id,
              MAX(t1_brand) AS t1_brand,
              MAX(t1_product) AS t1_product,
              MAX(t1_industry) AS t1_industry
       FROM diagnosis_brand WHERE deleted = 0
       GROUP BY diagnosis_task_id
     ) db2 ON db2.diagnosis_task_id = d.business_task_id
     WHERE ${where}
     ORDER BY e.modify_time DESC
     LIMIT ?`,
    [...params, Math.min(limit, 500)]
  );
  return {
    enabled: true,
    rows: (rows || []).map((r) => ({
      ...r,
      platform: resolvePlatform(r.aiModelId, r.aiModelName),
      status: Number(r.status),
      taskStatus: Number(r.taskStatus)
    }))
  };
}

async function rpaAnswersHandler(url) {
  const pool = getRpaPool();
  if (!pool) return { enabled: false, rows: [] };
  const execId = url.searchParams.get("executionId");
  if (execId) {
    const rows = await queryDb(
      pool,
      `SELECT
         a.id AS answerId,
         a.execution_id AS executionId,
         a.keyword,
         a.collection_time AS collectedAt,
         a.response_duration AS responseDurationSeconds,
         a.answer_content AS content,
         (SELECT COUNT(*) FROM rpa_answer_reference r WHERE r.answer_id = a.id) AS referenceCount
       FROM rpa_answer a
       WHERE a.execution_id = ? AND a.deleted = 0
       LIMIT 1`,
      [execId]
    );
    return { enabled: true, rows: rows || [] };
  }
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const rows = await queryDb(
    pool,
    `SELECT
       a.id AS answerId,
       a.execution_id AS executionId,
       a.keyword,
       a.collection_time AS collectedAt,
       a.response_duration AS responseDurationSeconds,
       a.answer_content AS content,
       (SELECT COUNT(*) FROM rpa_answer_reference r WHERE r.answer_id = a.id) AS referenceCount
     FROM rpa_answer a
     JOIN rpa_task_execution e ON e.id = a.execution_id AND e.deleted = 0
     JOIN brand_rpa_dispatch_task d ON d.id = e.task_id AND d.deleted = 0
     WHERE a.deleted = 0
     ORDER BY a.collection_time DESC
     LIMIT ?`,
    [Math.min(limit, 200)]
  );
  return { enabled: true, rows: rows || [] };
}

async function rpaReferencesHandler(url) {
  const pool = getRpaPool();
  if (!pool) return { enabled: false, rows: [] };
  const executionId = url.searchParams.get("executionId");
  const limit = Number(url.searchParams.get("limit") ?? 300);
  if (executionId) {
    const rows = await queryDb(
      pool,
      `SELECT
         r.reference_platform AS articlePlatform,
         r.reference_sort AS \`rank\`,
         r.reference_content AS title,
         r.reference_url AS url
       FROM rpa_answer_reference r
       WHERE r.answer_id = (SELECT answer_id FROM rpa_task_execution WHERE id = ? LIMIT 1)
       ORDER BY r.reference_sort`,
      [executionId]
    );
    return { enabled: true, rows: rows || [] };
  }
  // 无 executionId：返回最近的全部引用（用于总览），附带 keyword
  const rows = await queryDb(
    pool,
    `SELECT
       e.keyword,
       r.reference_platform AS articlePlatform,
       r.reference_sort AS \`rank\`,
       r.reference_content AS title,
       r.reference_url AS url,
       a.collection_time AS collectedAt
     FROM rpa_answer_reference r
     JOIN rpa_answer a ON a.id = r.answer_id
     JOIN rpa_task_execution e ON e.id = a.execution_id AND e.deleted = 0
     JOIN brand_rpa_dispatch_task d ON d.id = e.task_id AND d.deleted = 0
     ORDER BY a.collection_time DESC
     LIMIT ?`,
    [Math.min(limit, 2000)]
  );
  return { enabled: true, rows: rows || [] };
}

async function researchAnswersHandler(url) {
  const pool = getMainPool();
  if (!pool) return { enabled: false, rows: [] };
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const platform = url.searchParams.get("platform");
  const question = url.searchParams.get("question");
  let where = "1=1";
  const params = [];
  if (platform) { where += " AND p.code = ?"; params.push(platform); }
  if (question) { where += " AND q.content LIKE ?"; params.push(`%${question}%`); }
  const rows = await queryDb(
    pool,
    `SELECT
       a.task_id AS taskId,
       q.content AS question,
       p.code AS platformCode,
       p.name AS platformName,
       a.content,
       a.reference_count AS referenceCount,
       a.extracted_at AS extractedAt
     FROM answers a
     JOIN question_platform_tasks t ON t.id = a.task_id
     JOIN questions q ON q.id = t.question_id
     JOIN platforms p ON p.id = t.platform_id
     WHERE ${where}
     ORDER BY a.extracted_at DESC
     LIMIT ?`,
    [...params, Math.min(limit, 200)]
  );
  return { enabled: true, rows: rows || [] };
}

async function researchReferencesHandler(url) {
  const pool = getMainPool();
  if (!pool) return { enabled: false, rows: [] };
  const limit = Number(url.searchParams.get("limit") ?? 200);
  const platform = url.searchParams.get("platform");
  const question = url.searchParams.get("question");
  const taskId = url.searchParams.get("taskId");
  let where = "1=1";
  const params = [];
  if (taskId) { where += " AND r.task_id = ?"; params.push(taskId); }
  if (platform) { where += " AND p.code = ?"; params.push(platform); }
  if (question) { where += " AND q.content LIKE ?"; params.push(`%${question}%`); }
  const rows = await queryDb(
    pool,
    `SELECT
       r.task_id AS taskId,
       q.content AS question,
       p.code AS platformCode,
       p.name AS platformName,
       r.\`rank\` AS \`rank\`,
       r.article_platform AS articlePlatform,
       r.article_time AS articleTime,
       r.title,
       r.summary,
       r.url,
       r.extracted_at AS extractedAt
     FROM \`references\` r
     JOIN question_platform_tasks t ON t.id = r.task_id
     JOIN questions q ON q.id = t.question_id
     JOIN platforms p ON p.id = t.platform_id
     WHERE ${where}
     ORDER BY r.extracted_at DESC
     LIMIT ?`,
    [...params, Math.min(limit, 1000)]
  );
  return { enabled: true, rows: rows || [] };
}

async function rpaSectionsHandler() {
  const pool = getRpaPool();
  if (!pool) return { enabled: false, sections: {} };
  const rows = await queryDb(
    pool,
    `SELECT
       d.business_type AS businessType,
       SUM(CASE WHEN e.status = 0 AND e.task_status = 0 THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN e.status = 1 AND e.task_status = 1 THEN 1 ELSE 0 END) AS processing,
       SUM(CASE WHEN e.status = 2 AND e.task_status = 2 THEN 1 ELSE 0 END) AS succeeded,
       SUM(CASE WHEN e.status = 3 AND e.task_status = 3 THEN 1 ELSE 0 END) AS finalFailed
     FROM rpa_task_execution e
     JOIN brand_rpa_dispatch_task d ON d.id = e.task_id AND d.deleted = 0
     WHERE e.deleted = 0
     GROUP BY d.business_type`
  );
  const sections = {};
  for (const r of rows || []) {
    sections[r.businessType] = {
      pending: Number(r.pending),
      processing: Number(r.processing),
      succeeded: Number(r.succeeded),
      finalFailed: Number(r.finalFailed)
    };
  }
  return { enabled: true, sections };
}

/* ----------------------------- HTTP 路由 ----------------------------- */

const HTML_PATH = path.join(__dirname, "index.html");

const ROUTES = {
  "/api/overview": overviewHandler,
  "/api/rpa/tasks": rpaTasksHandler,
  "/api/rpa/sections": rpaSectionsHandler,
  "/api/rpa/answers": rpaAnswersHandler,
  "/api/rpa/references": rpaReferencesHandler,
  "/api/research/answers": researchAnswersHandler,
  "/api/research/references": researchReferencesHandler,
  "/api/research/files": () => readResearchFiles()
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsed.pathname;

  try {
    if (pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        mainDb: !!getMainPool(),
        rpaDb: !!getRpaPool(),
        time: new Date().toISOString()
      });
    }

    if (ROUTES[pathname]) {
      const data = await ROUTES[pathname](parsed);
      return sendJson(res, 200, data);
    }

    if (pathname === "/" || pathname === "/index.html") {
      if (!fs.existsSync(HTML_PATH)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("dashboard/index.html 未找到");
      }
      const html = fs.readFileSync(HTML_PATH, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    // 静态资源（仅白名单扩展名；禁止越出 dashboard 目录、禁止读到 server.mjs 源码）
    const ext = path.extname(pathname).toLowerCase();
    const STATIC_TYPES = {
      ".js": "application/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".json": "application/json",
      ".map": "application/json",
      ".ico": "image/x-icon"
    };
    if (STATIC_TYPES[ext]) {
      const decoded = decodeURIComponent(pathname);
      const safe = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
      const filePath = path.join(__dirname, safe);
      if (
        filePath.startsWith(__dirname + path.sep) &&
        path.basename(filePath) !== "server.mjs" &&
        fs.existsSync(filePath) &&
        fs.statSync(filePath).isFile()
      ) {
        const body = fs.readFileSync(filePath);
        res.writeHead(200, { "Content-Type": `${STATIC_TYPES[ext]}; charset=utf-8`, "Cache-Control": "no-store" });
        return res.end(body);
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`[dashboard] 运营台已启动: http://127.0.0.1:${PORT}`);
  console.log(`[dashboard] 主库(research): ${getMainPool() ? "已连接" : "未配置(DB_USER/DB_PASSWORD)"}`);
  console.log(`[dashboard] RPA库: ${getRpaPool() ? "已连接" : "未配置(RPA_DB_NAME/RPA_DB_USER/RPA_DB_PASSWORD)"}`);
});
