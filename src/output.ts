import fs from "node:fs/promises";
import path from "node:path";
import type { PlatformId, ReferenceRecord } from "./types.js";

export async function writeOutputs(outDir: string, records: ReferenceRecord[]): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "references.json");
  const csvPath = path.join(outDir, "references.csv");

  await fs.writeFile(jsonPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await fs.writeFile(csvPath, toCsv(records), "utf8");
}

export async function writePlatformOutputs(
  outDir: string,
  platformId: PlatformId,
  records: ReferenceRecord[]
): Promise<void> {
  await writeOutputs(path.join(outDir, platformId), records);
}

function toCsv(records: ReferenceRecord[]): string {
  const headers: Array<keyof ReferenceRecord> = [
    "question",
    "crawlPlatform",
    "rank",
    "articlePlatform",
    "articleTime",
    "title",
    "summary",
    "url",
    "extractedAt"
  ];

  const rows = records.map((record) => headers.map((header) => escapeCsv(String(record[header] ?? ""))).join(","));
  return `${headers.join(",")}\n${rows.join("\n")}\n`;
}

function escapeCsv(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
