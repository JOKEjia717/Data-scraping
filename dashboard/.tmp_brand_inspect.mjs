import mysql from "mysql2/promise";

const cfg = {
  host: "14.103.81.32",
  port: 3306,
  user: "root",
  password: "7sK9pQ2!xR8#bN3",
  database: "geno_digital",
  connectionLimit: 1,
  charset: "utf8mb4",
  connectTimeout: 8000,
};

const pool = mysql.createPool(cfg);

async function run() {
  // 1. brand_rpa_dispatch_task 结构
  const [cols] = await pool.query("DESCRIBE brand_rpa_dispatch_task");
  console.log("=== brand_rpa_dispatch_task 字段 ===");
  console.log(cols.map((c) => `${c.Field}  ${c.Type}`).join("\n"));

  // 2. 是否存在 brands 表
  const [brandTables] = await pool.query("SHOW TABLES LIKE '%brand%'");
  console.log("\n=== 含 brand 的表 ===");
  console.log(brandTables.map((r) => Object.values(r)[0]).join(", ") || "(无)");

  // 3. 若有 brands 表，看结构 + 样本
  for (const t of brandTables.map((r) => Object.values(r)[0])) {
    if (/^brands?$/i.test(t)) {
      const [bc] = await pool.query(`DESCRIBE \`${t}\``);
      console.log(`\n=== ${t} 字段 ===`);
      console.log(bc.map((c) => `${c.Field}  ${c.Type}`).join("\n"));
      const [sample] = await pool.query(`SELECT * FROM \`${t}\` LIMIT 5`);
      console.log(`\n=== ${t} 样本 ===`);
      console.log(JSON.stringify(sample, null, 1).slice(0, 1500));
    }
  }

  // 4. 采样一条 dispatch 任务，看 brand 相关字段实际值
  const [one] = await pool.query(
    `SELECT d.* FROM brand_rpa_dispatch_task d WHERE d.deleted = 0 LIMIT 1`
  );
  console.log("\n=== brand_rpa_dispatch_task 样本(1条) ===");
  console.log(JSON.stringify(one, null, 1).slice(0, 1500));

  await pool.end();
}

run().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
