import mysql from "mysql2/promise";
const cfg = { host: "14.103.81.32", port: 3306, user: "root", password: "7sK9pQ2!xR8#bN3", database: "geno_digital", connectionLimit: 1, charset: "utf8mb4", connectTimeout: 8000 };
const pool = mysql.createPool(cfg);

async function run() {
  // 用 GROUP BY 去重子查询，确认无重复行
  const [rows] = await pool.query(
    `SELECT e.id AS execId, db2.t1_brand AS brandName, db2.t1_product AS product
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
     WHERE e.deleted = 0 AND d.business_type = 'DIAGNOSIS' AND e.status = 2
     LIMIT 8`
  );
  console.log("样本(已运行, 去重子查询):");
  rows.forEach((r) => console.log(`  exec=${r.execId}  brand=${r.brandName}  product=${r.product}`));

  // 重复检查
  const [dup] = await pool.query(
    `SELECT COUNT(*) AS total, COUNT(DISTINCT e.id) AS distinctExec
     FROM rpa_task_execution e
     JOIN brand_rpa_dispatch_task d ON d.id = e.task_id AND d.deleted = 0
     LEFT JOIN (
       SELECT diagnosis_task_id, MAX(t1_brand) AS t1_brand, MAX(t1_product) AS t1_product, MAX(t1_industry) AS t1_industry
       FROM diagnosis_brand WHERE deleted = 0 GROUP BY diagnosis_task_id
     ) db2 ON db2.diagnosis_task_id = d.business_task_id
     WHERE e.deleted = 0 AND d.business_type = 'DIAGNOSIS' AND e.status = 2`
  );
  console.log(`\n总行数=${dup[0].total}  去重exec数=${dup[0].distinctExec}  (应相等=无重复)`);

  // 品牌分布（看阿里巴巴等是否合并）
  const [brands] = await pool.query(
    `SELECT db2.t1_brand AS brand, COUNT(*) AS n
     FROM rpa_task_execution e
     JOIN brand_rpa_dispatch_task d ON d.id = e.task_id AND d.deleted = 0
     LEFT JOIN (
       SELECT diagnosis_task_id, MAX(t1_brand) AS t1_brand FROM diagnosis_brand WHERE deleted = 0 GROUP BY diagnosis_task_id
     ) db2 ON db2.diagnosis_task_id = d.business_task_id
     WHERE e.deleted = 0 AND d.business_type = 'DIAGNOSIS' AND e.status = 2
       AND db2.t1_brand IS NOT NULL
     GROUP BY db2.t1_brand ORDER BY n DESC LIMIT 15`
  );
  console.log("\n=== 品牌分布 Top15 (真实品牌名) ===");
  brands.forEach((b) => console.log(`  ${String(b.n).padStart(4)}  ${b.brand}`));

  await pool.end();
}
run().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
