/**
 * 数据库配置回归测试。只验证环境变量解析，不连接真实 MySQL。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readDatabaseConfig } from "../src/database.js";

test("数据库配置使用安全默认值并保留大整数连接池参数", () => {
  const config = readDatabaseConfig({
    DB_USER: "crawler_app",
    DB_PASSWORD: "test-password"
  });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3306);
  assert.equal(config.database, "Data_Scraping");
  assert.equal(config.connectionLimit, 6);
  assert.equal(config.ssl, undefined);
});

test("数据库密码缺失时拒绝创建连接配置", () => {
  assert.throws(
    () => readDatabaseConfig({ DB_USER: "crawler_app" }),
    /缺少数据库配置 DB_PASSWORD/
  );
});

test("远程 TLS 模式缺少 CA 证书时拒绝连接", () => {
  assert.throws(
    () => readDatabaseConfig({
      DB_USER: "crawler_app",
      DB_PASSWORD: "test-password",
      DB_SSL: "true"
    }),
    /DB_SSL_CA_PATH/
  );
});
