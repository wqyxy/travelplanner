export type LabelBox = { id: string; x: number; y: number; width: number; height: number; priority: number };
export type LabelPlacement = LabelBox & { hidden?: boolean; dx: number; dy: number };
export type DayPathRole = { dayNumber: number; startEntityId: string; endEntityId: string };
export type LabelCluster<T extends LabelBox = LabelBox> = LabelBox & { members: T[] };
const overlaps = (a: LabelBox, b: LabelBox) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
export function layoutLabels<T extends LabelBox>(items: T[], viewport: { width: number; height: number }, obstacles: LabelBox[] = []): (T & Omit<LabelPlacement, keyof LabelBox>)[] {
  const placed: LabelBox[] = [...obstacles]; const positions = [[12,-30],[12,12],[-12,-30],[-12,12],[0,-46],[28,0],[-28,0],[0,28]];
  return [...items].sort((a,b) => b.priority-a.priority).map((item) => { for (const [dx,dy] of positions) for (const distance of [1,1.7,2.4,3.2]) { const next = { ...item, x: item.x + dx * distance, y: item.y + dy * distance }; if (next.x >= 2 && next.y >= 2 && next.x + next.width <= viewport.width - 2 && next.y + next.height <= viewport.height - 2 && !placed.some((other) => overlaps(next, other))) { placed.push(next); return { ...next, dx: next.x-item.x, dy: next.y-item.y }; } } return { ...item, hidden: true, dx: 0, dy: 0 }; });
}
export function labelRole(entityId: string, paths: DayPathRole[]) {
  const end = paths.filter((path) => path.endEntityId === entityId).map((path) => `D${path.dayNumber}终`);
  const start = paths.filter((path) => path.startEntityId === entityId).map((path) => `D${path.dayNumber}起`);
  return [...end, ...start].join(" / ");
}
export function clusterHiddenLabels<T extends LabelBox>(items: T[], padding = 28): LabelCluster<T>[] {
  const remaining = new Set(items.map((item) => item.id)); const byId = new Map(items.map((item) => [item.id, item])); const groups: LabelCluster<T>[] = [];
  while (remaining.size) { const seed = remaining.values().next().value as string; remaining.delete(seed); const members: T[] = []; const queue = [seed];
    while (queue.length) { const id = queue.pop()!; const item = byId.get(id)!; members.push(item); for (const candidateId of [...remaining]) { const candidate = byId.get(candidateId)!; const dx = candidate.x - item.x; const dy = candidate.y - item.y; if (dx * dx + dy * dy <= padding * padding) { remaining.delete(candidateId); queue.push(candidateId); } } }
    groups.push({ id: `cluster:${members.map((item) => item.id).sort().join(",")}`, members, x: members.reduce((sum, item) => sum + item.x, 0) / members.length, y: members.reduce((sum, item) => sum + item.y, 0) / members.length, width: 70, height: 26, priority: 4 });
  }
  return groups;
}
