import { describe, expect, it } from "vitest";
import { mapCategoryColorDefaults, sanitizeMapCategoryColors } from "./config.js";
describe("map category colors", () => { it("falls back per invalid value", () => { expect(sanitizeMapCategoryColors({ city: "#112233", meal: "red", extra: "#000000" })).toEqual({ ...mapCategoryColorDefaults, city: "#112233" }); }); });
