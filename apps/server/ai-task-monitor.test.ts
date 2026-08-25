import { describe, expect, it } from "vitest";
import { aiErrorMessage, isRepairableAiOutputError } from "./ai-task-monitor.js";

describe("AI error handling", () => {
  it("preserves non-empty string errors and falls back for unknown values", () => {
    expect(aiErrorMessage("Planner 合同修正仍未通过")).toBe("Planner 合同修正仍未通过");
    expect(aiErrorMessage({ message: "not trusted" })).toBe("服务器请求失败。");
  });

  it("repairs output errors but fails fast for program and service errors", () => {
    expect(isRepairableAiOutputError(new SyntaxError("bad JSON"))).toBe(true);
    expect(isRepairableAiOutputError(new Error("invalid mutation"))).toBe(true);
    expect(isRepairableAiOutputError(new ReferenceError("server bug"))).toBe(false);
    expect(isRepairableAiOutputError(Object.assign(new Error("database failure"), { code: "SQLITE_BUSY" }))).toBe(false);
  });
});
