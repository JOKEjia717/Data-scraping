import mysql from "mysql2/promise";
const cfg = { host: "14.103.81.32", port: 3306, user: "root", password: "7sK9pQ2!xR8#bN3", database: "geno_digital", connectionLimit: 1, charset: "utf8mb4", connectTimeout: 8000 };
const pool = mysql.createPool(cfg);

async function run() {
  const execId = 2068;
  // 关联方案1：d.business_task_id = db.id
  try {
    const [r] = await pool.query(
      `SELECT e.id AS execId, e.keyword, d.business_task_id,
              db.id AS db_id, db.diagnosis_task_id, db.t1_brand, db.t1_product, db.company_name
       FROM rpa_task_execution e
       JOIN brand_rpa_dispatch_task d ON d.id = e.task_id AND d.deleted = 0
       JOIN diagnosis_brand db ON db.id = d.business_task_id
       WHERE e.id = ?`,
      [execId]
    );
    console.log("=== 方案1: business_task_id = diagnosis_brand.id ===");
    console.log(JSON.stringify(r, null, 1).slice(0, 900));
  } catch (e) { console.log("方案1失败:", e.message); }

  // 关联方案2：d.business_task_id = db.diagnosis_task_id
  try {
    const [r] = await pool.query(
      `SELECT e.id AS execId, e.keyword, d.business_task_id,
              db.id AS db_id, db.diagnosis_task_id, db.t1_brand, db.t1_product, db.company_name
       FROM rpa_task_execution e
       JOIN brand_rpa_dispatch_task d ON d.id = e.task_id AND d.deleted = 0
       JOIN diagnosis_brand db ON db.diagnosis_task_id = d.business_task_id
       WHERE e.id = ?`,
      [execId]
    );
    console.log("\n=== 方案2: business_task_id = diagnosis_brand.diagnosis_task_id ===");
    console.log(JSON.stringify(r, null, 1).slice(0, 900));
  } catch (e) { console.log("方案2失败:", e.message); }

  // 统计：哪种关联能覆盖更多 DIAGNOSIS 任务
  const [c1] = await pool.query(
    `SELECT COUNT(*) AS n FROM rpa_task_execution e
     JOIN brand_rpa_dispatch_task d ON d.id = e.task_id AND d.deleted = 0
     JOIN diagnosis_brand db ON db.id = d.business_task_id
     WHERE e.deleted = 0 AND d.business_type = 'DIAGNOSIS'`
  );
  console.log("\n方案1 覆盖DIAGNOSIS任务数:", c1[0].n);
  const [c2] = await pool.query(
    `SELECT COUNT(*) AS n FROM rpa_task_execution e
     JOIN brand_rpa_dispatch_task d ON d.id = e.task_id AND d.deleted = 0
     JOIN diagnosis_brand db ON db.diagnosis_task_id = d.business_task_id
     WHERE e.deleted = 0 AND d.business_type = 'DIAGNOSIS'`
  );
  console.log("方案2 覆盖DIAGNOSIS任务数:", c2[0].n);

  await pool.end();
}
run().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
