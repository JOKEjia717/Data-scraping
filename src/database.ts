/**
 * MySQL 连接池与安全配置。
 *
 * 凭据仅从环境变量读取，不接受代码内默认密码。四个平台共享一个有限连接池，
 * 业务入库层通过该连接池执行参数化 SQL 和单题事务。
 */
import "dotenv/config";
import fs from "node:fs";
import mysql, {
  type Pool,
  type PoolOptions,
  type RowDataPacket
} from "mysql2/promise";

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
  ssl?: {
    ca?: Buffer;
    rejectUnauthorized: true;
  };
}

export interface DatabaseConnectionInfo {
  database: string;
  authenticatedUser: string;
  serverVersion: string;
}

let sharedPool: Pool | undefined;

/** 读取并校验环境变量；密码缺失时立即失败，避免意外尝试无密码连接。 */
export function readDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env
): DatabaseConfig {
  const port = readPositiveInteger(environment.DB_PORT ?? "3306", "DB_PORT");
  const connectionLimit = readPositiveInteger(
    environment.DB_CONNECTION_LIMIT ?? "6",
    "DB_CONNECTION_LIMIT"
  );
  const sslEnabled = environment.DB_SSL === "true";
  const caPath = environment.DB_SSL_CA_PATH?.trim();

  if (sslEnabled && !caPath) {
    throw new Error("DB_SSL=true 时必须配置 DB_SSL_CA_PATH。");
  }

  return {
    host: environment.DB_HOST?.trim() || "127.0.0.1",
    port,
    user: requireEnvironmentValue(environment, "DB_USER"),
    password: requireEnvironmentValue(environment, "DB_PASSWORD"),
    database: environment.DB_NAME?.trim() || "Data_Scraping",
    connectionLimit,
    ssl: sslEnabled
      ? {
          ca: fs.readFileSync(caPath!),
          rejectUnauthorized: true
        }
      : undefined
  };
}

/** 延迟创建共享连接池，未使用数据库功能时不会建立网络连接。 */
export function getDatabasePool(): Pool {
  if (sharedPool) return sharedPool;
  const config = readDatabaseConfig();
  const poolOptions: PoolOptions = {
    ...config,
    waitForConnections: true,
    queueLimit: 100,
    connectTimeout: 10_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    charset: "utf8mb4",
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true
  };
  sharedPool = mysql.createPool(poolOptions);
  return sharedPool;
}

/** 执行只读探针，同时确认实际连接的数据库、账号和服务端版本。 */
export async function verifyDatabaseConnection(): Promise<DatabaseConnectionInfo> {
  const [rows] = await getDatabasePool().query<Array<RowDataPacket & {
    databaseName: string;
    authenticatedUser: string;
    serverVersion: string;
  }>>(
    "SELECT DATABASE() AS databaseName, " +
    "CURRENT_USER() AS authenticatedUser, VERSION() AS serverVersion"
  );
  const row = rows[0];
  if (!row) throw new Error("MySQL 连接成功，但连接探针没有返回结果。");

  return {
    database: row.databaseName,
    authenticatedUser: row.authenticatedUser,
    serverVersion: row.serverVersion
  };
}

/** 测试或进程退出前主动释放连接池。 */
export async function closeDatabasePool(): Promise<void> {
  if (!sharedPool) return;
  const pool = sharedPool;
  sharedPool = undefined;
  await pool.end();
}

function requireEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  key: "DB_USER" | "DB_PASSWORD"
): string {
  const value = environment[key]?.trim();
  if (!value) {
    throw new Error(`缺少数据库配置 ${key}，请在 .env 中填写。`);
  }
  return value;
}

function readPositiveInteger(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} 必须是正整数，当前值：${value}`);
  }
  return parsed;
}
