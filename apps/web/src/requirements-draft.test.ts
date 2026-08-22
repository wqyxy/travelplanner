import { describe, expect, it } from "vitest";
import { canSaveRequirementsDraft, emptyRequirements, normalizeRequirements, shouldApplyRequirementsLoad, shouldPreserveDraftAfterSave } from "./requirements-draft";
describe("requirements drafts", () => {
  it("keeps edited fields and list additions while normalizing save content", () => { const value = emptyRequirements(); value.travelers.summary = "两位成人"; value.destinations.push({ city: " 京都 ", country: " 日本 " }); value.themes = ["美食", " "]; expect(normalizeRequirements(value)).toMatchObject({ travelers: { summary: "两位成人" }, destinations: [{ city: "京都", country: "日本" }], themes: ["美食"] }); });
  it("does not allow a trip A draft to be saved into trip B", () => { expect(canSaveRequirementsDraft("a", "b")).toBe(false); expect(canSaveRequirementsDraft("b", "b")).toBe(true); });
  it("keeps a same-trip dirty draft when a refresh response arrives", () => { expect(shouldApplyRequirementsLoad(false, true, false)).toBe(false); expect(shouldApplyRequirementsLoad(false, false, true)).toBe(false); expect(shouldApplyRequirementsLoad(true, true, false)).toBe(true); });
  it("keeps post-save edits while accepting the returned revision baseline", () => { expect(shouldPreserveDraftAfterSave(true)).toBe(true); expect(shouldPreserveDraftAfterSave(false)).toBe(false); });
});
