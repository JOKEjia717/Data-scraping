/**
 * 运营台 ↔ 爬虫程序 控制文件桥接
 *
 * 设计（与用户确认的方案）：
 *   - 每个开关对应一个「暂停/停止文件」，由运营台(server.mjs)写入/删除，
 *     由对应程序在循环/认领时检测。文件存在 = 暂停/停止；不存在 = 运行。
 *   - RPA worker 进程常驻，暂停只是「不再认领该业务类型的任务」，不退出进程。
 *   - 研究爬取(crawl)是独立程序，用 stop.request 优雅退出本轮。
 *
 * 路径约定（worker 与 server 必须解析到同一绝对路径）：
 *   rpa-runtime/<role>/pause-<BUSINESS_TYPE>.request
 *   rpa-runtime/research/stop.request
 *
 * ARTICLE_PROBE 与 CONTENT_STYLE_MONITOR 是两个独立协议类型，不能互设别名。
 */

import fs from "node:fs";
import path from "node:path";

/** 项目根目录（workerControl.ts 位于 src/，上溯一级即项目根）。 */
function projectRoot(): string {
  return path.resolve(import.meta.dirname ?? process.cwd(), "..");
}

/** worker 运行时根目录，例如 rpa-runtime/diagnosis、rpa-runtime/monitor。 */
export function controlDirForRole(role: string): string {
  return path.resolve(projectRoot(), "rpa-runtime", role);
}

/** 把 worker 内部业务类型归一化为控制文件的键名（DB 真实 business_type）。 */
export function pauseKeyForBusinessType(businessType: string): string {
  return businessType;
}

/** 某个业务类型的暂停文件路径（role 为 diagnosis / monitor）。 */
export function pauseFilePath(role: string, businessType: string): string {
  const key = pauseKeyForBusinessType(businessType);
  return path.join(controlDirForRole(role), `pause-${key}.request`);
}

/**
 * 控制文件约定（避免删除操作，兼容运行环境的 safe-delete 回收站保护）：
 *   - 文件常驻存在；内容为 ISO 时间戳 = 暂停/停止；内容为空 = 运行/启用。
 *   - 因此「启用」只需把文件清空（writeFileSync ""），从不执行删除。
 */

/** 读取控制文件内容（不存在视为空）。 */
function readControlContent(file: string): string {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

/** 某业务类型是否已暂停：文件存在且内容非空。 */
export function isBusinessTypePaused(role: string, businessType: string): boolean {
  const content = readControlContent(pauseFilePath(role, businessType));
  return content.trim().length > 0;
}

/** 列出该 worker 当前所有被暂停的业务类型（扫描 pause-*.request，仅含非空内容）。 */
export function pausedBusinessTypes(role: string): string[] {
  const dir = controlDirForRole(role);
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("pause-") && f.endsWith(".request"))
      .map((f) => f.slice("pause-".length, -".request".length))
      .filter((bt) => isBusinessTypePaused(role, bt));
  } catch {
    return [];
  }
}

/** 写入/清空某个业务类型的暂停文件。paused=true 写时间戳，false 写空（不删除）。 */
export function setBusinessTypePaused(role: string, businessType: string, paused: boolean): void {
  const dir = controlDirForRole(role);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pauseFilePath(role, businessType), paused ? new Date().toISOString() : "", "utf8");
}

/* --------------------------- 研究爬取(research) --------------------------- */

export function researchStopPath(): string {
  return path.join(controlDirForRole("research"), "stop.request");
}

/** 研究爬取是否收到停止信号：文件存在且内容非空。 */
export function isResearchStopRequested(): boolean {
  return readControlContent(researchStopPath()).trim().length > 0;
}

/** 写入/清空研究爬取的停止文件。stopped=true 写时间戳，false 写空（不删除）。 */
export function setResearchStopped(stopped: boolean): void {
  const dir = controlDirForRole("research");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(researchStopPath(), stopped ? new Date().toISOString() : "", "utf8");
}
