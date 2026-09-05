import { promises as fs } from "node:fs";
import path from "node:path";
import { projectPaths } from "./config.js";
import "./final-route-ai-cutover-v3.js";
import { loadPromptRegistryV3 } from "./prompt-registry-v3.js";
import { installRuntimeInvariantsV3 } from "./runtime-invariants-v3.js";
import { TravelStoreV3 } from "./travel-store-v3.js";

const root = path.resolve(process.cwd());
const paths = projectPaths(root);
await fs.mkdir(paths.privateRoot, { recursive: true });

// Atomic cutover guard:
// 1) strict Prompt Registry must be complete before server startup;
// 2) DB must be empty/fresh-v3 or already-complete-v3; v2/unknown fails closed;
// 3) final-route AI persistence is installed before the main runtime is constructed;
// 4) runtime database invariants are installed before the HTTP server can accept traffic.
await loadPromptRegistryV3(root);
const store = new TravelStoreV3(paths.travelV2Db);
store.close();
installRuntimeInvariantsV3(paths.travelV2Db);

await import("./index-v3.js");
