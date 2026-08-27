import type { IncomingMessage, ServerResponse } from "node:http";
import { CandidatePreferenceSchema, PlaceResolutionRetryInputSchema, ProposalScopeSchema } from "./contracts-v2.js";
import type { TravelPlannerRuntimeV2 } from "./planner-runtime-v2.js";
import type { TravelStoreV2 } from "./travel-store-v2.js";

export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求 JSON 必须是对象。");
  return value as Record<string, unknown>;
}

function decode(value: string) { return decodeURIComponent(value); }

export type TravelApiResponse = { status: number; data?: unknown; error?: { message: string; code?: string } };
export type TravelApiDeps = { store: TravelStoreV2; runtime: TravelPlannerRuntimeV2 };

export async function dispatchTravelApiV2(
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  body: Record<string, unknown>,
  deps: TravelApiDeps,
): Promise<TravelApiResponse | null> {
  if (method === "GET" && pathname === "/api/trips") return { status: 200, data: { trips: deps.store.listTrips(searchParams.get("view") === "trash" ? "trashed" : "active") } };
  if (method === "POST" && pathname === "/api/trips") return { status: 200, data: { trip: deps.store.createTrip() } };

  let match = /^\/api\/trips\/([^/]+)$/.exec(pathname);
  if (match) {
    const tripId = decode(match[1]);
    if (method === "GET") return { status: 200, data: { trip: deps.store.requireTrip(tripId) } };
    if (method === "PATCH") {
      let trip = deps.store.requireTrip(tripId);
      if (body.title !== undefined) trip = deps.store.rename(tripId, String(body.title));
      if (body.planLanguage !== undefined) {
        if (body.planLanguage !== "zh" && body.planLanguage !== "en" && body.planLanguage !== "bilingual") throw new Error("planLanguage 必须是 zh、en 或 bilingual。");
        trip = deps.store.setPlanLanguage(tripId, body.planLanguage);
      }
      return { status: 200, data: { trip } };
    }
    if (method === "DELETE") {
      deps.store.setState(tripId, "trashed");
      return { status: 200, data: { ok: true } };
    }
  }

  match = /^\/api\/trips\/([^/]+)\/workspace$/.exec(pathname);
  if (method === "GET" && match) return { status: 200, data: deps.runtime.workspace(decode(match[1])) };

  match = /^\/api\/trips\/([^/]+)\/duplicate$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: { trip: deps.store.duplicate(decode(match[1])) } };
  match = /^\/api\/trips\/([^/]+)\/restore$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: { trip: deps.store.setState(decode(match[1]), "active") } };
  match = /^\/api\/trips\/([^/]+)\/permanent$/.exec(pathname);
  if (method === "DELETE" && match) {
    deps.store.permanentDelete(decode(match[1]));
    return { status: 200, data: { ok: true } };
  }

  match = /^\/api\/trips\/([^/]+)\/messages$/.exec(pathname);
  if (method === "GET" && match) return { status: 200, data: { messages: deps.store.listMessages(decode(match[1])) } };
  match = /^\/api\/trips\/([^/]+)\/turns$/.exec(pathname);
  if (method === "POST" && match) return { status: 202, data: deps.runtime.startConversation(decode(match[1]), String(body.message ?? "")) };

  match = /^\/api\/trips\/([^/]+)\/candidates\/discover$/.exec(pathname);
  if (method === "POST" && match) {
    if (body.mode !== "macro" && body.mode !== "micro") throw new Error("候选地点发现 mode 必须是 macro 或 micro。");
    const planningAreaCandidateIds = Array.isArray(body.planningAreaCandidateIds) ? body.planningAreaCandidateIds.map(String) : [];
    return { status: 202, data: deps.runtime.startCandidateDiscovery(decode(match[1]), body.mode, planningAreaCandidateIds, typeof body.message === "string" ? body.message : null) };
  }
  match = /^\/api\/trips\/([^/]+)\/candidates\/batch$/.exec(pathname);
  if (method === "POST" && match) {
    const preference = CandidatePreferenceSchema.parse(body.preference);
    const candidateIds = Array.isArray(body.candidateIds) ? body.candidateIds.map(String) : [];
    return {
      status: 200,
      data: await deps.runtime.applyCommands(decode(match[1]), {
        expectedGeneration: body.expectedGeneration,
        commands: [{ type: "bulk_set_candidate_preference", candidateIds, preference }],
      }),
    };
  }
  match = /^\/api\/trips\/([^/]+)\/candidates\/([^/]+)$/.exec(pathname);
  if (method === "PATCH" && match) {
    const tripId = decode(match[1]);
    const candidateId = decode(match[2]);
    const preference = CandidatePreferenceSchema.parse(body.preference);
    return {
      status: 200,
      data: await deps.runtime.applyCommands(tripId, {
        expectedGeneration: body.expectedGeneration,
        commands: [{ type: "set_candidate_preference", candidateId, preference }],
      }),
    };
  }

  match = /^\/api\/trips\/([^/]+)\/plan\/generate$/.exec(pathname);
  if (method === "POST" && match) return { status: 202, data: deps.runtime.startPlanGeneration(decode(match[1])) };
  match = /^\/api\/trips\/([^/]+)\/refinement\/next$/.exec(pathname);
  if (method === "POST" && match) {
    const dayIds = Array.isArray(body.dayIds) ? body.dayIds.map(String) : null;
    return { status: 202, data: deps.runtime.startRefinement(decode(match[1]), dayIds) };
  }
  match = /^\/api\/trips\/([^/]+)\/commands$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: await deps.runtime.applyCommands(decode(match[1]), body) };

  match = /^\/api\/trips\/([^/]+)\/resolutions\/retry$/.exec(pathname);
  if (method === "POST" && match) {
    const input = PlaceResolutionRetryInputSchema.parse(body);
    return { status: 200, data: { results: await deps.runtime.retryResolutions(decode(match[1]), input.placeIds, input.expectedGeneration) } };
  }
  match = /^\/api\/trips\/([^/]+)\/resolutions\/([^/]+)\/candidates$/.exec(pathname);
  if (method === "GET" && match) {
    const expectedGeneration = Number(searchParams.get("expectedGeneration"));
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error("expectedGeneration 无效。");
    return { status: 200, data: { candidates: await deps.runtime.searchResolutionCandidates(decode(match[1]), decode(match[2]), expectedGeneration) } };
  }
  match = /^\/api\/trips\/([^/]+)\/resolutions\/([^/]+)\/select$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: await deps.runtime.selectResolution(decode(match[1]), decode(match[2]), body) };
  match = /^\/api\/trips\/([^/]+)\/resolutions\/([^/]+)\/manual$/.exec(pathname);
  if (method === "PUT" && match) return { status: 200, data: { resolution: await deps.runtime.setDirectResolution(decode(match[1]), decode(match[2]), body) } };

  match = /^\/api\/trips\/([^/]+)\/routes\/recalculate$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: await deps.runtime.recalculateDirtyRoutes(decode(match[1]), body) };
  match = /^\/api\/trips\/([^/]+)\/routes\/([^/]+)\/recalculate$/.exec(pathname);
  if (method === "POST" && match) {
    const expectedGeneration = Number(body.expectedGeneration);
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error("expectedGeneration 无效。");
    return { status: 200, data: { route: await deps.runtime.recalculateRoute(decode(match[1]), decode(match[2]), expectedGeneration) } };
  }

  match = /^\/api\/trips\/([^/]+)\/proposals$/.exec(pathname);
  if (method === "POST" && match) {
    const scope = ProposalScopeSchema.parse(body.scope);
    return { status: 202, data: deps.runtime.startProposal(decode(match[1]), scope, String(body.message ?? "")) };
  }
  match = /^\/api\/trips\/([^/]+)\/proposals\/([^/]+)\/apply$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: await deps.runtime.applyProposal(decode(match[1]), decode(match[2])) };
  match = /^\/api\/trips\/([^/]+)\/proposals\/([^/]+)\/reject$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: { proposal: deps.runtime.rejectProposal(decode(match[1]), decode(match[2])) } };
  match = /^\/api\/trips\/([^/]+)\/proposals\/([^/]+)\/undo$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: deps.runtime.undoProposal(decode(match[1]), decode(match[2])) };

  match = /^\/api\/trips\/([^/]+)\/revisions$/.exec(pathname);
  if (method === "GET" && match) return { status: 200, data: { revisions: deps.store.listRevisions(decode(match[1])) } };
  match = /^\/api\/trips\/([^/]+)\/revisions\/(\d+)$/.exec(pathname);
  if (method === "GET" && match) return { status: 200, data: { revision: deps.store.getRevision(decode(match[1]), Number(match[2])) } };
  match = /^\/api\/trips\/([^/]+)\/revisions\/(\d+)\/restore$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: deps.runtime.restoreRevision(decode(match[1]), Number(match[2])) };

  match = /^\/api\/trips\/([^/]+)\/ai-tasks$/.exec(pathname);
  if (method === "GET" && match) return { status: 200, data: { tasks: deps.store.listAiTasks(decode(match[1])) } };
  match = /^\/api\/trips\/([^/]+)\/ai-tasks\/([^/]+)\/stop$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: deps.runtime.stopTask(decode(match[1]), decode(match[2])) };

  return null;
}

export async function handleTravelApiV2(request: IncomingMessage, response: ServerResponse, deps: TravelApiDeps) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const body = request.method === "GET" || request.method === "HEAD" ? {} : await readJsonBody(request);
  const result = await dispatchTravelApiV2(request.method ?? "GET", url.pathname, url.searchParams, body, deps);
  if (!result) return false;
  response.writeHead(result.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(result.error ? { error: result.error } : { data: result.data }));
  return true;
}
