import { z } from "zod";
import type { TravelPlanDocument } from "./contracts-v2.js";

const OrganizerIdSchema = z.string().trim().min(1).max(160);
const OrganizerNameSchema = z.string().trim().min(1).max(300);

export const PlaceOrganizerPlaceV3Schema = z.object({
  id: OrganizerIdSchema,
  name: OrganizerNameSchema,
}).strict();

export const PlaceOrganizerOutputV3Schema = z.object({
  blocks: z.array(z.object({
    id: OrganizerIdSchema,
    places: z.array(PlaceOrganizerPlaceV3Schema),
  }).strict()).min(1),
}).strict();

export type PlaceOrganizerOutputV3 = z.infer<typeof PlaceOrganizerOutputV3Schema>;

export type PlaceOrganizerContextV3 = {
  blocks: Array<{
    id: string;
    fixedEndPlaceId: string;
    places: Array<{ id: string; name: string }>;
  }>;
};

function routeNodePlaceName(plan: TravelPlanDocument, nodeId: string) {
  const node = plan.finalRoute.nodes.find((item) => item.id === nodeId && item.status === "normal");
  if (!node) throw new Error(`AI_PLACE_ORGANIZER_UNKNOWN_NODE: 找不到正常最终线路节点 ${nodeId}。`);
  const place = plan.places.find((item) => item.id === node.placeId);
  if (!place) throw new Error(`AI_PLACE_ORGANIZER_UNKNOWN_PLACE: 线路节点 ${nodeId} 引用未知 Place ${node.placeId}。`);
  return place.nameZh || place.nameLocal || place.nameEn || node.id;
}

function organizerBlockForDay(plan: TravelPlanDocument, day: TravelPlanDocument["days"][number]) {
  const nodeIds = [...day.stops.map((stop) => stop.id), day.id];
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw new Error(`AI_PLACE_ORGANIZER_DUPLICATE_NODE: Day ${day.id} 中存在重复线路节点。`);
  }
  return {
    id: day.id,
    fixedEndPlaceId: day.id,
    places: nodeIds.map((id) => ({ id, name: routeNodePlaceName(plan, id) })),
  };
}

/**
 * Thin bridge between canonical finalRoute and AI ordering.
 * It intentionally exports only block identity plus route-node id/name pairs.
 * Candidate role/kind is not exposed, so macro destinations and detailed POIs
 * are treated identically once they are in finalRoute.
 */
export function buildPlaceOrganizerContextV3(
  plan: TravelPlanDocument,
  input: { scope: "trip" } | { scope: "day"; dayId: string },
): PlaceOrganizerContextV3 {
  const days = input.scope === "day"
    ? plan.days.filter((day) => day.id === input.dayId)
    : plan.days;
  if (!days.length) throw new Error("AI_PLACE_ORGANIZER_EMPTY_SCOPE: 当前 AI 排序范围没有可用日程块。");
  if (input.scope === "day" && days.length !== 1) throw new Error(`AI_PLACE_ORGANIZER_UNKNOWN_DAY: 找不到 Day ${input.dayId}。`);
  return { blocks: days.map((day) => organizerBlockForDay(plan, day)) };
}

export function placeOrganizerNodeIdsV3(context: PlaceOrganizerContextV3) {
  return context.blocks.flatMap((block) => block.places.map((place) => place.id));
}

export function validatePlaceOrganizerOutputV3(
  context: PlaceOrganizerContextV3,
  value: unknown,
): PlaceOrganizerOutputV3 {
  const output = PlaceOrganizerOutputV3Schema.parse(value);
  const expectedBlockIds = context.blocks.map((block) => block.id);
  const returnedBlockIds = output.blocks.map((block) => block.id);
  if (JSON.stringify(expectedBlockIds) !== JSON.stringify(returnedBlockIds)) {
    throw new Error("AI_PLACE_ORGANIZER_BLOCK_SCOPE_VIOLATION: AI 排序必须原样保留日程块及其顺序。");
  }

  const expectedPlaces = new Map(context.blocks.flatMap((block) => block.places.map((place) => [place.id, place.name] as const)));
  const returnedPlaces = output.blocks.flatMap((block) => block.places);
  const returnedIds = returnedPlaces.map((place) => place.id);
  if (returnedIds.length !== expectedPlaces.size || new Set(returnedIds).size !== returnedIds.length || returnedIds.some((id) => !expectedPlaces.has(id))) {
    throw new Error("AI_PLACE_ORGANIZER_PLACE_SCOPE_VIOLATION: AI 排序必须恰好返回授权范围内的全部地点，且每个地点只能出现一次。");
  }
  for (const place of returnedPlaces) {
    if (expectedPlaces.get(place.id) !== place.name) {
      throw new Error(`AI_PLACE_ORGANIZER_NAME_MUTATION_FORBIDDEN: AI 不得修改地点名称 ${place.id}。`);
    }
  }

  for (const [index, block] of context.blocks.entries()) {
    const returned = output.blocks[index];
    if (returned.places.at(-1)?.id !== block.fixedEndPlaceId) {
      throw new Error(`AI_PLACE_ORGANIZER_DAY_BOUNDARY_FORBIDDEN: Day ${block.id} 的住宿/日终节点必须保持在本日最后。`);
    }
  }
  return output;
}

function namesByNodeId(context: PlaceOrganizerContextV3) {
  return new Map(context.blocks.flatMap((block) => block.places.map((place) => [place.id, place.name] as const)));
}

/** Convert an ordered node sequence back into the bridge JSON. Day-end nodes close blocks. */
export function placeOrganizerOutputFromOrderedNodeIdsV3(
  context: PlaceOrganizerContextV3,
  orderedNodeIds: string[],
): PlaceOrganizerOutputV3 {
  const names = namesByNodeId(context);
  let cursor = 0;
  const blocks = context.blocks.map((block) => {
    const places: Array<{ id: string; name: string }> = [];
    while (cursor < orderedNodeIds.length) {
      const id = orderedNodeIds[cursor++];
      const name = names.get(id);
      if (!name) throw new Error(`AI_PLACE_ORGANIZER_UNKNOWN_OUTPUT_NODE: AI 排序返回未知线路节点 ${id}。`);
      places.push({ id, name });
      if (id === block.fixedEndPlaceId) break;
    }
    return { id: block.id, places };
  });
  if (cursor !== orderedNodeIds.length) throw new Error("AI_PLACE_ORGANIZER_EXTRA_OUTPUT: AI 排序返回了日程块范围外的地点。");
  return validatePlaceOrganizerOutputV3(context, { blocks });
}

/** Convert Day-like AI output into the canonical bridge JSON, restoring names server-side. */
export function placeOrganizerOutputFromDaysV3(
  context: PlaceOrganizerContextV3,
  days: Array<{ id: string; stops: Array<{ id: string }> }>,
): PlaceOrganizerOutputV3 {
  const names = namesByNodeId(context);
  const blocks = days.map((day) => ({
    id: day.id,
    places: [...day.stops.map((stop) => stop.id), day.id].map((id) => {
      const name = names.get(id);
      if (!name) throw new Error(`AI_PLACE_ORGANIZER_UNKNOWN_OUTPUT_NODE: AI 排序返回未知线路节点 ${id}。`);
      return { id, name };
    }),
  }));
  return validatePlaceOrganizerOutputV3(context, { blocks });
}

export function placeOrganizerOrderedNodeIdsV3(
  context: PlaceOrganizerContextV3,
  value: unknown,
) {
  const output = validatePlaceOrganizerOutputV3(context, value);
  return output.blocks.flatMap((block) => block.places.map((place) => place.id));
}
