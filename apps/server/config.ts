import { promises as fs } from "node:fs";
import path from "node:path";
import type { PasswordRecord } from "./auth.js";

export type UiSettings = { workspaceSplitRatio: number; theme: "light" | "dark"; requirementsPanelOpen: boolean };
export type AiSettings = { model: string; reasoningEffort: string };
export type AppConfig = PasswordRecord & { version: 1; username?: string; port: number; ui: UiSettings; ai: AiSettings };
export const defaultConfig = (): AppConfig => ({ version: 1, port: 6688, ui: { workspaceSplitRatio: .52, theme: "light", requirementsPanelOpen: true }, ai: { model: "", reasoningEffort: "medium" } });
export const projectPaths = (root: string) => ({ privateRoot: path.join(root, "private_data"), config: path.join(root, "private_data", "web-ui.json"), travelDb: path.join(root, "private_data", "travel.sqlite3"), cacheDb: path.join(root, "private_data", "public-data-cache.sqlite3") });
export async function loadConfig(root: string): Promise<AppConfig> { const target = projectPaths(root).config; try { const parsed = JSON.parse(await fs.readFile(target, "utf8")) as Partial<AppConfig>; const merged = { ...defaultConfig(), ...parsed, ui: { ...defaultConfig().ui, ...parsed.ui }, ai: { ...defaultConfig().ai, ...parsed.ai } }; if (merged.port === 5888 || merged.port === 6666) merged.port = 6688; return merged; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig(); throw error; } }
export async function saveConfig(root: string, config: AppConfig) { const paths = projectPaths(root); await fs.mkdir(paths.privateRoot, { recursive: true }); const temporary = `${paths.config}.tmp`; await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await fs.rename(temporary, paths.config); }
