/**
 * 数据库连接检查入口。只执行 SELECT 探针，不创建、修改或删除任何业务数据。
 */
import {
  closeDatabasePool,
  verifyDatabaseConnection
} from "./database.js";

async function main(): Promise<void> {
  try {
    const info = await verifyDatabaseConnection();
    console.log("MySQL 连接成功");
    console.log(`数据库：${info.database}`);
    console.log(`认证账号：${info.authenticatedUser}`);
    console.log(`服务端版本：${info.serverVersion}`);
  } finally {
    await closeDatabasePool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
