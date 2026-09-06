export type FinalRouteDropPositionV4 = "before" | "after";

export function finalRouteMoveTargetIndexV4(
  dragIndex: number,
  targetRowIndex: number,
  position: FinalRouteDropPositionV4,
  nodeCount: number,
) {
  if (!Number.isInteger(dragIndex) || !Number.isInteger(targetRowIndex) || !Number.isInteger(nodeCount)) return null;
  if (nodeCount <= 0 || dragIndex < 0 || dragIndex >= nodeCount || targetRowIndex < 0 || targetRowIndex >= nodeCount) return null;

  const insertionSlot = targetRowIndex + (position === "after" ? 1 : 0);
  const targetIndex = insertionSlot > dragIndex ? insertionSlot - 1 : insertionSlot;
  if (targetIndex === dragIndex) return null;
  return Math.max(0, Math.min(nodeCount - 1, targetIndex));
}
