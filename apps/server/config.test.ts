import { describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, mapCategoryColorDefaults, projectPaths, sanitizeMapCategoryColors } from "./config.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
describe("map category colors", () => { it("falls back per invalid value", () => { expect(sanitizeMapCategoryColors({ city: "#112233", meal: "red", extra: "#000000" })).toEqual({ ...mapCategoryColorDefaults, city: "#112233" }); }); });
describe("UI settings", () => { it("defaults a missing sidebar preference to open", async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), "travel-config-")); try { const target = projectPaths(root).config; await fs.mkdir(path.dirname(target), { recursive: true }); const config = defaultConfig(); const { sidebarOpen: _sidebarOpen, ...ui } = config.ui; await fs.writeFile(target, JSON.stringify({ ...config, ui })); expect((await loadConfig(root)).ui.sidebarOpen).toBe(true); } finally { await fs.rm(root, { recursive: true, force: true }); } }); });
