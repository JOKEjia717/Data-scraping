import type { RpaBusinessType } from "./rpaTask.js";
import type { ReferenceExtractionStatus, ReferenceRecord } from "./types.js";

export function assertPersistableReferenceResult(
  status: ReferenceExtractionStatus,
  references: readonly ReferenceRecord[],
  businessType: RpaBusinessType
): void {
  const valid = status === "EXTRACTED"
    ? references.length > 0
    : status === "CONFIRMED_EMPTY" && references.length === 0;
  if (!valid) {
    throw Object.assign(
      new Error(
        `${businessType} 引用状态 ${status} 不能持久化为成功结果`
      ),
      { errorCode: "REFERENCE_UNKNOWN" }
    );
  }
}
