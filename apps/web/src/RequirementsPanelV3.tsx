import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { TripFacts } from "./v2-types";

type BriefField = keyof TripFacts["brief"];

const fields: Array<{ key: BriefField; label: string; placeholder: string; required?: boolean; multiline?: boolean }> = [
  { key: "destination", label: "目的地", placeholder: "例如：英国", required: true },
  { key: "origin", label: "出发地", placeholder: "例如：上海或伦敦希思罗机场" },
  { key: "departureTime", label: "出发时间", placeholder: "例如：9 月、国庆前后" },
  { key: "duration", label: "旅行时长", placeholder: "例如：10 天左右" },
  { key: "travelers", label: "同行者", placeholder: "例如：两位成人、一位儿童" },
  { key: "transport", label: "出行方式", placeholder: "例如：自驾" },
  { key: "additionalRequirements", label: "其他需求", placeholder: "例如：不赶早、每天驾驶不超过 3 小时、需要无障碍设施", multiline: true },
];

export function RequirementsPanelV3({ facts, busy, onSave, onGenerate }: {
  facts: TripFacts;
  busy: boolean;
  onSave: (changes: Partial<TripFacts["brief"]>) => Promise<boolean>;
  onGenerate: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(facts.brief);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  useEffect(() => { setDraft(facts.brief); }, [facts.brief]);

  const save = async (key: BriefField) => {
    const value = draft[key].trim();
    if (value === facts.brief[key]) return;
    setStatus("saving");
    setStatus(await onSave({ [key]: value }) ? "saved" : "failed");
  };

  const destinationReady = draft.destination.trim().length > 0 && facts.brief.destination.trim() === draft.destination.trim();
  return <section className="workspace-requirements-v3 requirements-form-v3">
    <div><p className="eyebrow">STEP 1</p><h2>旅行需求</h2><p>填写你已知的信息即可，可以用“英国”“9 月”“10 天左右”这类自然表达。离开输入框会自动保存；不知道的内容可以先留空。</p></div>
    <div className="requirements-fields-v3">
      {fields.map((field) => <label key={field.key} className={field.multiline ? "wide" : undefined}><span>{field.label}{field.required ? <em>必填</em> : null}</span>{field.multiline
        ? <textarea value={draft[field.key]} disabled={busy} placeholder={field.placeholder} onChange={(event) => { setStatus("idle"); setDraft((current) => ({ ...current, [field.key]: event.target.value })); }} onBlur={() => void save(field.key)}/>
        : <input value={draft[field.key]} disabled={busy} placeholder={field.placeholder} onChange={(event) => { setStatus("idle"); setDraft((current) => ({ ...current, [field.key]: event.target.value })); }} onBlur={() => void save(field.key)}/>}</label>)}
    </div>
    <small className={`requirements-save-status-v3 ${status}`}>{status === "saving" ? "正在保存…" : status === "saved" ? "已保存" : status === "failed" ? "保存失败，请再次离开输入框重试。" : ""}</small>
    <button className="button primary workspace-primary-cta-v3" type="button" disabled={busy || !destinationReady} title={destinationReady ? undefined : "请先填写并保存目的地"} onClick={() => void onGenerate()}><ArrowRight size={15}/>下一步：想去哪些地方</button>
  </section>;
}
