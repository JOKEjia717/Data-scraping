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
  // rpa_task_execution 是否有品牌字段
  const [ec] = await pool.query("DESCRIBE rpa_task_execution");
  console.log("=== rpa_task_execution 字段 ===");
  console.log(ec.map((c) => `${c.Field}  ${c.Type}`).join("\n"));

  // diagnosis_brand
  const [dc] = await pool.query("DESCRIBE diagnosis_brand");
  console.log("\n=== diagnosis_brand 字段 ===");
  console.log(dc.map((c) => `${c.Field}  ${c.Type}`).join("\n"));
  const [ds] = await pool.query("SELECT * FROM diagnosis_brand LIMIT 3");
  console.log("\n=== diagnosis_brand 样本 ===");
  console.log(JSON.stringify(ds, null, 1).slice(0, 1800));

  // brand_info
  const [bc] = await pool.query("DESCRIBE brand_info");
  console.log("\n=== brand_info 字段 ===");
  console.log(bc.map((c) => `${c.Field}  ${c.Type}`).join("\n"));
  const [bs] = await pool.query("SELECT * FROM brand_info LIMIT 3");
  console.log("\n=== brand_info 样本 ===");
  console.log(JSON.stringify(bs, null, 1).slice(0, 1800));

  // 试关联：dispatch.business_task_id -> diagnosis_brand.id
  try {
    const [j] = await pool.query(
      `SELECT d.id AS dispatchId, d.business_task_id, db.id AS brandId, db.brand_name
       FROM brand_rpa_dispatch_task d
       JOIN diagnosis_brand db ON db.id = d.business_task_id
       WHERE d.deleted = 0 AND d.business_type = 'DIAGNOSIS'
       LIMIT 5`
    );
    console.log("\n=== dispatch JOIN diagnosis_brand (by business_task_id=brand.id) ===");
    console.log(JSON.stringify(j, null, 1).slice(0, 1200));
  } catch (e) {
    console.log("\n[关联A失败]", e.message);
  }

  // 试关联：task_id 直接指向 diagnosis_brand
  try {
    const [j2] = await pool.query(
      `SELECT e.id AS execId, e.task_id, db.id AS brandId, db.brand_name
       FROM rpa_task_execution e
       JOIN brand_rpa_dispatch_task d ON d.id = e.task_id AND d.deleted = 0
       JOIN diagnosis_brand db ON db.id = d.business_task_id
       WHERE e.deleted = 0 AND d.business_type = 'DIAGNOSIS'
       LIMIT 5`
    );
    console.log("\n=== execution -> dispatch -> diagnosis_brand ===");
    console.log(JSON.stringify(j2, null, 1).slice(0, 1200));
  } catch (e) {
    console.log("\n[关联B失败]", e.message);
  }

  await pool.end();
}
run().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
