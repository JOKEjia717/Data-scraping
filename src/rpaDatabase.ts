/** geno-digital-api RPA 表专用连接池；凭据只从 RPA_DB_* 环境变量读取。 */
import "dotenv/config";
import fs from "node:fs";
import mysql, { type Pool, type PoolOptions } from "mysql2/promise";

export interface RpaDatabaseConfig {
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

let sharedRpaPool: Pool | undefined;

export function readRpaDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env
): RpaDatabaseConfig {
  const sslEnabled = environment.RPA_DB_SSL === "true";
  const caPath = environment.RPA_DB_SSL_CA_PATH?.trim();
  if (sslEnabled && !caPath) {
    throw new Error("RPA_DB_SSL=true 时必须配置 RPA_DB_SSL_CA_PATH。");
  }
  return {
    host: environment.RPA_DB_HOST?.trim() || "127.0.0.1",
    port: positiveInteger(environment.RPA_DB_PORT ?? "3306", "RPA_DB_PORT"),
    user: required(environment, "RPA_DB_USER"),
    password: required(environment, "RPA_DB_PASSWORD"),
    database: required(environment, "RPA_DB_NAME"),
    connectionLimit: positiveInteger(
      environment.RPA_DB_CONNECTION_LIMIT ?? "4",
      "RPA_DB_CONNECTION_LIMIT"
    ),
    ssl: sslEnabled
      ? {
          ca: fs.readFileSync(caPath!),
          rejectUnauthorized: true
        }
      : undefined
  };
}

export function getRpaDatabasePool(): Pool {
  if (sharedRpaPool) return sharedRpaPool;
  const config = readRpaDatabaseConfig();
  const options: PoolOptions = {
    ...config,
    waitForConnections: true,
    queueLimit: 50,
    connectTimeout: 10_000,
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
