import { promises as fs } from "node:fs";
import path from "node:path";
import type { PasswordRecord } from "./auth.js";

export const mapCategoryColorDefaults = { city: "#1b4f78", attraction: "#e11d48", lodging: "#7c3aed", meal: "#d97706", stop: "#0891b2", waypoint: "#64748b" } as const;
export type MapCategoryColors = Record<keyof typeof mapCategoryColorDefaults, string>;
export function sanitizeMapCategoryColors(value: unknown): MapCategoryColors { const raw = value && typeof value === "object" ? value as Record<string, unknown> : {}; return Object.fromEntries(Object.entries(mapCategoryColorDefaults).map(([key, fallback]) => [key, typeof raw[key] === "string" && /^#[0-9a-f]{6}$/i.test(raw[key]) ? raw[key] : fallback])) as MapCategoryColors; }
export type UiSettings = { workspaceSplitRatio: number; theme: "light" | "dark"; requirementsPanelOpen: boolean; sidebarOpen: boolean; mapCategoryColors: MapCategoryColors };
export type AiSettings = { model: string; reasoningEffort: string };
export type AppConfig = PasswordRecord & { version: 1; username?: string; sessionKey?: string; port: number; ui: UiSettings; ai: AiSettings };
export const defaultConfig = (): AppConfig => ({ version: 1, port: 6688, ui: { workspaceSplitRatio: .52, theme: "light", requirementsPanelOpen: true, sidebarOpen: true, mapCategoryColors: { ...mapCategoryColorDefaults } }, ai: { model: "", reasoningEffort: "medium" } });
export const projectPaths = (root: string) => ({ privateRoot: path.join(root, "private_data"), config: path.join(root, "private_data", "web-ui.json"), travelDb: path.join(root, "private_data", "travel.sqlite3"), cacheDb: path.join(root, "private_data", "public-data-cache.sqlite3") });
export async function loadConfig(root: string): Promise<AppConfig> { const target = projectPaths(root).config; try { const parsed = JSON.parse(await fs.readFile(target, "utf8")) as Partial<AppConfig>; const base = defaultConfig(); const colors = sanitizeMapCategoryColors(parsed.ui?.mapCategoryColors); const merged = { ...base, ...parsed, ui: { ...base.ui, ...parsed.ui, sidebarOpen: typeof parsed.ui?.sidebarOpen === "boolean" ? parsed.ui.sidebarOpen : true, mapCategoryColors: colors }, ai: { ...base.ai, ...parsed.ai } }; if (merged.port === 5888 || merged.port === 6666) merged.port = 6688; return merged; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig(); throw error; } }
export async function saveConfig(root: string, config: AppConfig) { const paths = projectPaths(root); await fs.mkdir(paths.privateRoot, { recursive: true }); const temporary = `${paths.config}.tmp`; await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await fs.rename(temporary, paths.config); }
