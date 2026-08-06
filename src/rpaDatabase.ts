/** geno-digital-api RPA 表专用连接池；凭据只从 RPA_DB_* 环境变量读取。 */
import "dotenv/config";
import fs from "node:fs";
import mysql, { type Pool, type PoolConnection, type PoolOptions } from "mysql2/promise";

export interface RpaDatabaseTimeoutConfig {
  connectTimeoutMs: number;
  acquireTimeoutMs: number;
  queryTimeoutMs: number;
  lockQueryTimeoutMs: number;
}

export interface RpaDatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
  maxIdle: number;
  idleTimeoutMs: number;
  queueLimit: number;
  timeouts: RpaDatabaseTimeoutConfig;
  ssl?: {
    ca?: Buffer;
    rejectUnauthorized: true;
  };
}

let sharedRpaPool: Pool | undefined;

export function readRpaDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env
): RpaDatabaseConfig {
  const sslEnabled = environment.RPA_DB_SSL === "true";
  const caPath = environment.RPA_DB_SSL_CA_PATH?.trim();
  if (sslEnabled && !caPath) {
    throw new Error("RPA_DB_SSL=true 时必须配置 RPA_DB_SSL_CA_PATH。");
  }
  const connectionLimit = positiveInteger(
    environment.RPA_DB_CONNECTION_LIMIT ?? "4",
    "RPA_DB_CONNECTION_LIMIT"
  );
  return {
    host: environment.RPA_DB_HOST?.trim() || "127.0.0.1",
    port: positiveInteger(environment.RPA_DB_PORT ?? "3306", "RPA_DB_PORT"),
    user: required(environment, "RPA_DB_USER"),
    password: required(environment, "RPA_DB_PASSWORD"),
    database: required(environment, "RPA_DB_NAME"),
    connectionLimit,
    maxIdle: positiveInteger(
      environment.RPA_DB_MAX_IDLE ?? String(connectionLimit),
      "RPA_DB_MAX_IDLE"
    ),
    idleTimeoutMs: positiveInteger(
      environment.RPA_DB_IDLE_TIMEOUT_MS ?? "60000",
      "RPA_DB_IDLE_TIMEOUT_MS"
    ),
    queueLimit: positiveInteger(
      environment.RPA_DB_QUEUE_LIMIT ?? "50",
      "RPA_DB_QUEUE_LIMIT"
    ),
    timeouts: readRpaDatabaseTimeoutConfig(environment),
    ssl: sslEnabled
      ? {
          ca: fs.readFileSync(caPath!),
          rejectUnauthorized: true
        }
      : undefined
  };
}

export function readRpaDatabaseTimeoutConfig(
  environment: NodeJS.ProcessEnv = process.env
): RpaDatabaseTimeoutConfig {
  return {
    connectTimeoutMs: positiveInteger(
      environment.RPA_DB_CONNECT_TIMEOUT_MS ?? "10000",
      "RPA_DB_CONNECT_TIMEOUT_MS"
    ),
    acquireTimeoutMs: positiveInteger(
      environment.RPA_DB_ACQUIRE_TIMEOUT_MS ?? "10000",
      "RPA_DB_ACQUIRE_TIMEOUT_MS"
    ),
    queryTimeoutMs: positiveInteger(
      environment.RPA_DB_QUERY_TIMEOUT_MS ?? "15000",
      "RPA_DB_QUERY_TIMEOUT_MS"
    ),
    lockQueryTimeoutMs: positiveInteger(
      environment.RPA_DB_LOCK_QUERY_TIMEOUT_MS ?? "5000",
      "RPA_DB_LOCK_QUERY_TIMEOUT_MS"
    )
  };
}

export function getRpaDatabasePool(): Pool {
  if (sharedRpaPool) return sharedRpaPool;
  const config = readRpaDatabaseConfig();
  const {
    maxIdle,
    idleTimeoutMs,
    queueLimit,
    timeouts,
    ...connectionOptions
  } = config;
  const options: PoolOptions = {
    ...connectionOptions,
    waitForConnections: true,
    maxIdle,
    idleTimeout: idleTimeoutMs,
    queueLimit,
    connectTimeout: timeouts.connectTimeoutMs,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    charset: "utf8mb4",
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true
  };
  sharedRpaPool = mysql.createPool(options);
  return sharedRpaPool;
}

/**
 * mysql2 does not expose an acquire timeout for promise pools. This wrapper also
 * releases a connection that arrives after the caller has already timed out.
 */
export function acquireRpaPoolConnection(
  pool: Pick<Pool, "getConnection">,
  timeoutMs = readRpaDatabaseTimeoutConfig().acquireTimeoutMs
): Promise<PoolConnection> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(Object.assign(
        new Error(`Timed out acquiring an RPA database connection after ${timeoutMs}ms`),
        { code: "RPA_DB_ACQUIRE_TIMEOUT" }
      ));
    }, timeoutMs);
    void pool.getConnection().then((connection) => {
      if (settled) {
        connection.release();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(connection);
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function closeRpaDatabasePool(): Promise<void> {
  if (!sharedRpaPool) return;
  const pool = sharedRpaPool;
  sharedRpaPool = undefined;
  await pool.end();
}

function required(
  environment: NodeJS.ProcessEnv,
  key: "RPA_DB_USER" | "RPA_DB_PASSWORD" | "RPA_DB_NAME"
): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`缺少 RPA 数据库配置 ${key}。`);
  return value;
}

function positiveInteger(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} 必须是正整数，当前值：${value}`);
  }
  return parsed;
}
