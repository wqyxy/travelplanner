import { describe, expect, it } from "vitest";
import { validatePasswordChange } from "./password-change.js";

describe("validatePasswordChange", () => {
  it("accepts six-character and long passwords", () => {
    expect(validatePasswordChange("123456", "123456")).toBe("");
    expect(validatePasswordChange("x".repeat(10000), "x".repeat(10000))).toBe("");
  });
  it("requires six characters and matching confirmation", () => {
    expect(validatePasswordChange("12345", "12345")).toContain("至少");
    expect(validatePasswordChange("123456", "654321")).toContain("不一致");
  });
});
