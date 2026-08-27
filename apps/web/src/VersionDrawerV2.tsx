import { useEffect, useState } from "react";
import { api } from "./api";
import type { Revision, TravelPlanDocument } from "./v2-types";

type RevisionDetail = Revision & { plan: TravelPlanDocument };

export function VersionDrawerV2({ tripId, open, onClose, onRestored }: { tripId: string | null; open: boolean; onClose: () => void; onRestored: () => void }) {
  const [items, setItems] = useState<Revision[]>([]); const [selected, setSelected] = useState<RevisionDetail | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open && tripId) { void api<{ revisions: Revision[] }>(`/api/trips/${tripId}/revisions`).then((value) => setItems(value.revisions)); setSelected(null); } }, [open, tripId]);
  if (!open) return null;
  const preview = async (version: number) => { if (tripId) setSelected((await api<{ revision: RevisionDetail | null }>(`/api/trips/${tripId}/revisions/${version}`)).revision); };
  const restore = async () => { if (!tripId || !selected) return; setBusy(true); try { await api(`/api/trips/${tripId}/revisions/${selected.version}/restore`, { method: "POST", body: "{}" }); onRestored(); onClose(); } finally { setBusy(false); } };
  return <div className="version-overlay"><aside className="version-drawer"><header><strong>版本历史</strong><button onClick={onClose}>关闭</button></header><div className="version-body"><div className="version-list">{items.map((item) => <button key={item.version} onClick={() => void preview(item.version)}><b>v{item.version}</b><span>{item.summary}</span><small>{new Date(item.createdAt).toLocaleString("zh-CN")}</small></button>)}</div><div className="version-preview">{selected ? <><p className="eyebrow">VERSION {selected.version}</p><h2>{selected.plan.trip.title}</h2><p>{selected.plan.candidates.length} 个候选地点 · {selected.plan.days.length} 天 · {selected.plan.stage}</p><button className="button primary" disabled={busy} onClick={() => void restore()}>恢复为新版本</button></> : <p>选择一个版本查看摘要。</p>}</div></div></aside></div>;
}
