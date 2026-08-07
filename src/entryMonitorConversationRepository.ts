import { promises as fs } from "node:fs";
import path from "node:path";
import {
  serializeEntryMonitorConversationKey,
  type EntryMonitorConversationKey
} from "./entryMonitor.js";

export type EntryMonitorConversationStatus = "ACTIVE" | "UNAVAILABLE" | "EXPIRED";

export interface EntryMonitorConversation extends EntryMonitorConversationKey {
  conversationKey: string;
  conversationUrl: string;
  status: EntryMonitorConversationStatus;
  createdAt: string;
  lastUsedAt: string;
  unavailableReason?: string;
}

export interface EntryMonitorConversationRepository {
  find(key: EntryMonitorConversationKey): Promise<EntryMonitorConversation | undefined>;
  upsertActive(record: EntryMonitorConversation): Promise<void>;
  updateUrl(key: EntryMonitorConversationKey, url: string): Promise<void>;
  touch(key: EntryMonitorConversationKey, usedAt: Date): Promise<void>;
  markUnavailable(key: EntryMonitorConversationKey, reason: string): Promise<void>;
  closeExpired(beforeDate: string): Promise<number>;
}

interface ConversationFile {
  schemaVersion: 1;
  conversations: EntryMonitorConversation[];
}

/**
 * 单机灰度会话仓储。生产多 Worker 需要由 Java 提供集中式等价协议；本实现不会
 * 被 diagnosis 创建或读取，也不会把临时空队列解释成删除会话。
 */
export class JsonEntryMonitorConversationRepository
implements EntryMonitorConversationRepository {
  private queue = Promise.resolve();

  constructor(readonly filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  find(key: EntryMonitorConversationKey): Promise<EntryMonitorConversation | undefined> {
    return this.serial(async () => {
      const id = serializeEntryMonitorConversationKey(key);
      const record = (await this.read()).conversations.find(
        ({ conversationKey }) => conversationKey === id
      );
      return record ? { ...record } : undefined;
    });
  }

  upsertActive(record: EntryMonitorConversation): Promise<void> {
    return this.serial(async () => {
      validateRecord(record);
      const file = await this.read();
      const normalized = normalizedRecord(record);
      const index = file.conversations.findIndex(
        ({ conversationKey }) => conversationKey === normalized.conversationKey
      );
      if (index === -1) file.conversations.push(normalized);
      else file.conversations[index] = normalized;
      await this.write(file);
    });
  }

  updateUrl(key: EntryMonitorConversationKey, url: string): Promise<void> {
    return this.serial(async () => {
      const file = await this.read();
      const record = requireRecord(file, key);
      record.conversationUrl = safeHttpUrl(url);
      record.status = "ACTIVE";
      delete record.unavailableReason;
      await this.write(file);
    });
  }

  touch(key: EntryMonitorConversationKey, usedAt: Date): Promise<void> {
    return this.serial(async () => {
      const file = await this.read();
      const record = requireRecord(file, key);
      record.lastUsedAt = validDate(usedAt, "usedAt").toISOString();
      await this.write(file);
    });
  }

  markUnavailable(key: EntryMonitorConversationKey, reason: string): Promise<void> {
    return this.serial(async () => {
      const file = await this.read();
      const record = requireRecord(file, key);
      record.status = "UNAVAILABLE";
      record.unavailableReason = nonEmpty(reason, "reason").slice(0, 500);
      await this.write(file);
    });
  }

  closeExpired(beforeDate: string): Promise<number> {
    return this.serial(async () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) {
        throw new Error("beforeDate 必须是 YYYY-MM-DD。");
      }
      const file = await this.read();
      let count = 0;
      for (const record of file.conversations) {
        if (record.monitorDate < beforeDate && record.status === "ACTIVE") {
          record.status = "EXPIRED";
          count++;
        }
      }
      if (count > 0) await this.write(file);
      return count;
    });
  }

  private async read(): Promise<ConversationFile> {
    const raw = await fs.readFile(this.filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (raw === undefined) return { schemaVersion: 1, conversations: [] };
    const parsed = JSON.parse(raw) as Partial<ConversationFile>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.conversations)) {
      throw new Error("ENTRY_MONITOR 会话仓储格式无效。");
    }
    parsed.conversations.forEach(validateRecord);
    return { schemaVersion: 1, conversations: parsed.conversations.map(normalizedRecord) };
  }

  private async write(file: ConversationFile): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(file)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await fs.rename(temporaryPath, this.filePath);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function requireRecord(
  file: ConversationFile,
  key: EntryMonitorConversationKey
): EntryMonitorConversation {
  const id = serializeEntryMonitorConversationKey(key);
  const record = file.conversations.find(({ conversationKey }) => conversationKey === id);
  if (!record) throw new Error(`ENTRY_MONITOR 会话不存在：${id}`);
  return record;
}

function normalizedRecord(record: EntryMonitorConversation): EntryMonitorConversation {
  return {
    ...record,
    conversationKey: serializeEntryMonitorConversationKey(record),
    conversationUrl: safeHttpUrl(record.conversationUrl),
    createdAt: validDate(new Date(record.createdAt), "createdAt").toISOString(),
    lastUsedAt: validDate(new Date(record.lastUsedAt), "lastUsedAt").toISOString(),
    ...(record.unavailableReason
      ? { unavailableReason: nonEmpty(record.unavailableReason, "unavailableReason").slice(0, 500) }
      : {})
  };
}

function validateRecord(record: EntryMonitorConversation): void {
  if (!record || typeof record !== "object") throw new Error("ENTRY_MONITOR 会话记录无效。");
  const expectedKey = serializeEntryMonitorConversationKey(record);
  if (record.conversationKey !== expectedKey) {
    throw new Error("ENTRY_MONITOR conversationKey 与归属字段不一致。");
  }
  safeHttpUrl(record.conversationUrl);
  if (!["ACTIVE", "UNAVAILABLE", "EXPIRED"].includes(record.status)) {
    throw new Error("ENTRY_MONITOR 会话状态无效。");
  }
  validDate(new Date(record.createdAt), "createdAt");
  validDate(new Date(record.lastUsedAt), "lastUsedAt");
}

function safeHttpUrl(value: string): string {
  const parsed = new URL(nonEmpty(value, "conversationUrl"));
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("conversationUrl 必须使用 http 或 https。");
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

function validDate(value: Date, field: string): Date {
  if (!Number.isFinite(value.getTime())) throw new Error(`${field} 不是有效日期。`);
  return value;
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空。`);
  return value.trim();
}
