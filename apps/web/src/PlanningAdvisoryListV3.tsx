import { CircleAlert, Info } from "lucide-react";
import type { PlanningAdvisoryV3, WorkflowStepV3 } from "./v3-types";

function publicAdvisoryMessageV3(message: string) {
  return message
    .replace(/planning_area/giu, "主要线路区域")
    .replace(/planningRole/giu, "内部规划角色")
    .replace(/Planning Area/gu, "主要线路区域")
    .replace(/Candidate/gu, "地点")
    .replace(/每日行程/gu, "当前线路安排");
}

export function PlanningAdvisoryListV3({ advisories, step, steps }: { advisories: PlanningAdvisoryV3[]; step?: WorkflowStepV3; steps?: WorkflowStepV3[] }) {
  const visibleSteps = new Set(steps ?? (step ? [step] : []));
  const items = visibleSteps.size ? advisories.filter((item) => visibleSteps.has(item.workflowStep)) : advisories;
  if (!items.length) return null;
  const warnings = items.filter((item) => item.severity === "warning");
  const infos = items.filter((item) => item.severity === "info");
  const primary = warnings.slice(0, 3);
  const rest = [...warnings.slice(3), ...infos];

  return <section className="planning-advisories-v3" aria-label="规划提醒">
    {primary.map((item) => <div className="phase6-update-card" key={item.id}>
      <CircleAlert size={16}/><div><strong>规划提醒</strong><p>{publicAdvisoryMessageV3(item.message)}</p></div>
    </div>)}
    {rest.length > 0 && <details className="phase6-context-details">
      <summary><Info size={14}/> 还有 {rest.length} 条规划提醒</summary>
      <div>{rest.map((item) => <p key={item.id}>{publicAdvisoryMessageV3(item.message)}</p>)}</div>
    </details>}
  </section>;
}
