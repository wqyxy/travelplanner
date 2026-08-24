import { useEffect, useState } from "react";
import { X } from "lucide-react";

export const defaultMapCategoryColors = { city: "#1b4f78", attraction: "#e11d48", lodging: "#7c3aed", meal: "#d97706", stop: "#0891b2", waypoint: "#64748b" };
const labels: Record<string, string> = { city: "城市", attraction: "景点", lodging: "住宿", meal: "餐饮", stop: "交通/停靠", waypoint: "途经点" };
export function SettingsDrawer({ colors, onSave, onClose, onPreview }: { colors: Record<string, string>; onSave: (colors: Record<string, string>) => Promise<void>; onClose: () => void; onPreview?: (colors: Record<string, string>) => void }) {
  const [draft, setDraft] = useState(colors); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const preview = (next: Record<string, string>) => { onPreview?.(next); };
  useEffect(() => { setDraft(colors); preview(colors); }, [colors]);
  const update = (next: Record<string, string>) => { setDraft(next); preview(next); };
  const dismiss = () => { preview(colors); onClose(); };
  const save = async () => { if (Object.values(draft).some((value) => !/^#[0-9a-f]{6}$/i.test(value))) return setError("颜色必须是 #RRGGBB。"); setError(""); setSaving(true); try { await onSave(draft); onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : "保存颜色失败。"); } finally { setSaving(false); } };
  return <div className="settings-overlay" role="presentation" onMouseDown={dismiss}><aside className="settings-drawer" role="dialog" aria-modal="true" aria-label="地图显示设置" onMouseDown={(event) => event.stopPropagation()}><header><div><strong>地图标识设置</strong><small>分类颜色会立即反映在地图上</small></div><button className="icon-button" type="button" aria-label="关闭地图显示设置" onClick={dismiss}><X size={17}/></button></header><div className="settings-body">{Object.keys(defaultMapCategoryColors).map((key) => <label className="color-setting" key={key}><span>{labels[key]}</span><input type="color" aria-label={`${labels[key]}颜色`} value={draft[key]} onChange={(event) => update({ ...draft, [key]: event.target.value.toUpperCase() })}/><input aria-label={`${labels[key]} HEX 颜色`} value={draft[key]} maxLength={7} onChange={(event) => update({ ...draft, [key]: event.target.value.toUpperCase() })}/><button type="button" onClick={() => update({ ...draft, [key]: defaultMapCategoryColors[key as keyof typeof defaultMapCategoryColors] })}>默认</button></label>)}{error && <p className="inline-error">{error}</p>}</div><footer><button type="button" onClick={() => update({ ...defaultMapCategoryColors })}>全部恢复默认</button><button type="button" onClick={dismiss}>取消</button><button className="button primary" type="button" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存颜色"}</button></footer></aside></div>;
}
