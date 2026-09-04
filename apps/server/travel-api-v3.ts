import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CandidatePreferenceSchema,
  GoogleMapsLinkCommitInputSchema,
  GoogleMapsLinkPreviewInputSchema,
  PlaceResolutionRetryInputSchema,
  ProviderPlaceCandidateSchema,
} from "./contracts-v2.js";
import { AiActionTypeSchema, ConversationStageSchema, WorkspaceSelectionV3Schema } from "./ai-stage-contracts-v3.js";
import { confirmDetailToCorePromotionV3 } from "./core-promotion-v3.js";
import { normalizeDetailDayCtaActionV3 } from "./detail-day-cta-v3.js";
import { derivePlanningAdvisoriesV3 } from "./planning-advisories-v3.js";
import { normalizeRequirementsCtaParametersV3 } from "./requirements-duration-v3.js";
import { recoverReplanCtaParametersV3 } from "./replan-intent-v3.js";
import { saveSkeletonEditDraftV3 } from "./skeleton-edit-api-v3.js";
import type { TravelPlannerRuntimeV3 } from "./planner-runtime-v3.js";
import type { TravelStoreV3 } from "./travel-store-v3.js";

export async function readJsonBodyV3(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求 JSON 必须是对象。");
  return value as Record<string, unknown>;
}

function decode(value: string) { return decodeURIComponent(value); }
export type TravelApiV3Response = { status: number; data?: unknown; error?: { message: string; code?: string } };
export type TravelApiV3Deps = { store: TravelStoreV3; runtime: TravelPlannerRuntimeV3 };

export async function dispatchTravelApiV3(
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  body: Record<string, unknown>,
  deps: TravelApiV3Deps,
): Promise<TravelApiV3Response | null> {
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
    if (method === "DELETE") { deps.store.setState(tripId, "trashed"); return { status: 200, data: { ok: true } }; }
  }

  match = /^\/api\/trips\/([^/]+)\/workspace$/.exec(pathname);
  if (method === "GET" && match) {
    const workspace = deps.runtime.workspace(decode(match[1]));
    return {
      status: 200,
      data: {
        ...workspace,
        advisories: derivePlanningAdvisoriesV3(workspace.trip.plan, workspace.resolutions),
      },
    };
  }

  match = /^\/api\/trips\/([^/]+)\/duplicate$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: { trip: deps.store.duplicate(decode(match[1])) } };
  match = /^\/api\/trips\/([^/]+)\/restore$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: { trip: deps.store.setState(decode(match[1]), "active") } };
  match = /^\/api\/trips\/([^/]+)\/permanent$/.exec(pathname);
  if (method === "DELETE" && match) { deps.store.permanentDelete(decode(match[1])); return { status: 200, data: { ok: true } }; }

  match = /^\/api\/trips\/([^/]+)\/stages\/([^/]+)\/messages$/.exec(pathname);
  if (method === "GET" && match) {
    const stage = ConversationStageSchema.parse(decode(match[2]));
    return { status: 200, data: { messages: deps.store.listMessages(decode(match[1]), stage), actions: deps.store.listActions(decode(match[1]), stage) } };
  }
  match = /^\/api\/trips\/([^/]+)\/stages\/([^/]+)\/turns$/.exec(pathname);
  if (method === "POST" && match) {
    const tripId = decode(match[1]);
    const stage = ConversationStageSchema.parse(decode(match[2]));
    return {
      status: 202,
      data: deps.runtime.startConversation(tripId, stage, {
        message: body.message,
        selection: WorkspaceSelectionV3Schema.parse(body.selection ?? { type: "trip", id: null }),
      }),
    };
  }

  match = /^\/api\/trips\/([^/]+)\/actions\/cta$/.exec(pathname);
  if (method === "POST" && match) {
    const tripId = decode(match[1]);
    const stage = ConversationStageSchema.parse(body.stage);
    const requestedActionType = AiActionTypeSchema.parse(body.actionType);
    const requestKey = String(body.requestKey ?? "").trim();
    if (!requestKey || requestKey.length > 160) throw new Error("CTA requestKey 必须是 1–160 字符的稳定请求键。");
    const rawParameters = body.parameters && typeof body.parameters === "object" && !Array.isArray(body.parameters) ? body.parameters as Record<string, unknown> : {};
    const targetIds = Array.isArray(body.targetIds) ? body.targetIds.map(String).slice(0, 200) : [];
    const plan = deps.store.requireTrip(tripId).plan;
    const actionType = normalizeDetailDayCtaActionV3(plan, requestedActionType, rawParameters, targetIds);
    const normalizedParameters = normalizeRequirementsCtaParametersV3(plan, actionType, rawParameters);
    const parameters = recoverReplanCtaParametersV3(deps.store, tripId, actionType, normalizedParameters);
    return { status: 202, data: deps.runtime.createCtaAction({ tripId, stage, actionType, parameters, targetIds, requestKey }) };
  }

  match = /^\/api\/trips\/([^/]+)\/actions\/([^/]+)\/confirm$/.exec(pathname);
  if (method === "POST" && match) {
    const tripId = decode(match[1]);
    const actionId = decode(match[2]);
    const promoted = confirmDetailToCorePromotionV3(deps.store, tripId, actionId, body);
    return { status: 202, data: promoted ?? deps.runtime.confirmAction(tripId, actionId, body) };
  }
  match = /^\/api\/trips\/([^/]+)\/actions\/([^/]+)\/cancel$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: deps.runtime.cancelAction(decode(match[1]), decode(match[2]), body) };

  match = /^\/api\/trips\/([^/]+)\/candidates\/batch$/.exec(pathname);
  if (method === "POST" && match) {
    const preference = CandidatePreferenceSchema.parse(body.preference);
    const candidateIds = Array.isArray(body.candidateIds) ? body.candidateIds.map(String) : [];
    return { status: 200, data: deps.runtime.applyCommands(decode(match[1]), { expectedGeneration: body.expectedGeneration, commands: [{ type: "bulk_set_candidate_preference", candidateIds, preference }] }) };
  }
  match = /^\/api\/trips\/([^/]+)\/candidates\/([^/]+)$/.exec(pathname);
  if (method === "PATCH" && match) {
    const preference = CandidatePreferenceSchema.parse(body.preference);
    return { status: 200, data: deps.runtime.applyCommands(decode(match[1]), { expectedGeneration: body.expectedGeneration, commands: [{ type: "set_candidate_preference", candidateId: decode(match[2]), preference }] }) };
  }

  match = /^\/api\/trips\/([^/]+)\/skeleton$/.exec(pathname);
  if (method === "PUT" && match) return { status: 200, data: await saveSkeletonEditDraftV3(deps.store, deps.runtime, decode(match[1]), body) };

  match = /^\/api\/trips\/([^/]+)\/commands$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: deps.runtime.applyCommands(decode(match[1]), body) };

  match = /^\/api\/trips\/([^/]+)\/places\/([^/]+)\/google-maps$/.exec(pathname);
  if (match && method === "POST") return { status: 200, data: await deps.runtime.previewGoogleMapsLink(decode(match[1]), decode(match[2]), GoogleMapsLinkPreviewInputSchema.parse(body)) };
  if (match && method === "PUT") return { status: 200, data: await deps.runtime.applyGoogleMapsLink(decode(match[1]), decode(match[2]), GoogleMapsLinkCommitInputSchema.parse(body)) };

  match = /^\/api\/trips\/([^/]+)\/resolutions\/retry$/.exec(pathname);
  if (method === "POST" && match) {
    const input = PlaceResolutionRetryInputSchema.parse(body);
    return { status: 200, data: { results: await deps.runtime.retryResolutions(decode(match[1]), input.placeIds, input.expectedGeneration, input.force) } };
  }
  match = /^\/api\/trips\/([^/]+)\/resolutions\/([^/]+)\/candidates$/.exec(pathname);
  if (method === "GET" && match) {
    const expectedGeneration = Number(searchParams.get("expectedGeneration"));
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error("expectedGeneration 无效。");
    const ranked = await deps.runtime.searchResolutionCandidates(decode(match[1]), decode(match[2]), expectedGeneration);
    const candidates = ProviderPlaceCandidateSchema.array().parse(ranked.map((item) => item.candidate));
    return { status: 200, data: { candidates } };
  }
  match = /^\/api\/trips\/([^/]+)\/resolutions\/([^/]+)\/select$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: await deps.runtime.selectResolution(decode(match[1]), decode(match[2]), body) };
  match = /^\/api\/trips\/([^/]+)\/resolutions\/([^/]+)\/manual$/.exec(pathname);
  if (method === "PUT" && match) return { status: 200, data: { resolution: await deps.runtime.setDirectResolution(decode(match[1]), decode(match[2]), body) } };

  match = /^\/api\/trips\/([^/]+)\/routes\/recalculate$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: await deps.runtime.recalculateDirtyRoutes(decode(match[1]), body) };
  match = /^\/api\/trips\/([^/]+)\/macro-routes\/recalculate$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: await deps.runtime.recalculateDirtyMacroRoutes(decode(match[1]), body) };
  match = /^\/api\/trips\/([^/]+)\/macro-routes\/([^/]+)\/recalculate$/.exec(pathname);
  if (method === "POST" && match) {
    const expectedGeneration = Number(body.expectedGeneration);
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error("expectedGeneration 无效。");
    return { status: 200, data: { route: await deps.runtime.recalculateMacroRoute(decode(match[1]), decode(match[2]), expectedGeneration) } };
  }
  match = /^\/api\/trips\/([^/]+)\/routes\/([^/]+)\/recalculate$/.exec(pathname);
  if (method === "POST" && match) {
    const expectedGeneration = Number(body.expectedGeneration);
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error("expectedGeneration 无效。");
    return { status: 200, data: { route: await deps.runtime.recalculateRoute(decode(match[1]), decode(match[2]), expectedGeneration) } };
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
  if (method === "POST" && match) return { status: 200, data: deps.store.restoreRevision(decode(match[1]), Number(match[2])) };

  match = /^\/api\/trips\/([^/]+)\/ai-tasks$/.exec(pathname);
  if (method === "GET" && match) return { status: 200, data: { tasks: deps.store.listAiTasks(decode(match[1])) } };
  match = /^\/api\/trips\/([^/]+)\/ai-tasks\/([^/]+)\/stop$/.exec(pathname);
  if (method === "POST" && match) return { status: 200, data: deps.runtime.stopTask(decode(match[1]), decode(match[2])) };

  return null;
}

export async function handleTravelApiV3(request: IncomingMessage, response: ServerResponse, deps: TravelApiV3Deps) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const body = request.method === "GET" || request.method === "HEAD" ? {} : await readJsonBodyV3(request);
  const result = await dispatchTravelApiV3(request.method ?? "GET", url.pathname, url.searchParams, body, deps);
  if (!result) return false;
  response.writeHead(result.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(result.error ? { error: result.error } : { data: result.data }));
  return true;
}