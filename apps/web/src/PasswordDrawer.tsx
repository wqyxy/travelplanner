import { type FormEvent, useEffect, useState } from "react";
import { X } from "lucide-react";
import { api } from "./api";
import { validatePasswordChange } from "./password-change";

export function PasswordDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [newPassword, setNewPassword] = useState(""); const [confirmation, setConfirmation] = useState(""); const [error, setError] = useState(""); const [success, setSuccess] = useState(""); const [saving, setSaving] = useState(false);
  useEffect(() => { if (!open) { setNewPassword(""); setConfirmation(""); setError(""); setSuccess(""); } }, [open]);
  async function submit(event: FormEvent) { event.preventDefault(); const validation = validatePasswordChange(newPassword, confirmation); if (validation) return setError(validation); setError(""); setSuccess(""); setSaving(true); try { await api("/api/auth/password", { method: "PUT", body: JSON.stringify({ newPassword }) }); setNewPassword(""); setConfirmation(""); setSuccess("密码已更新；当前所有登录和连接保持有效。"); } catch (cause) { setError(cause instanceof Error ? cause.message : "更新密码失败。"); } finally { setSaving(false); } }
  if (!open) return null;
  return <div className="password-overlay" role="presentation" onMouseDown={onClose}><aside className="password-drawer" role="dialog" aria-modal="true" aria-labelledby="password-drawer-title" onMouseDown={(event) => event.stopPropagation()}><header><div><strong id="password-drawer-title">修改密码</strong><small>设置新的旅行空间访问密码。</small></div><button className="icon-button" type="button" aria-label="关闭修改密码" onClick={onClose}><X size={17}/></button></header><form onSubmit={(event) => void submit(event)}><label>新密码<input required type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label><label>确认新密码<input required type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label><small>至少 6 个字符。</small>{error && <p className="inline-error" role="alert">{error}</p>}{success && <p className="password-success" role="status">{success}</p>}<footer><button type="button" onClick={onClose}>取消</button><button className="button primary" disabled={saving}>{saving ? "更新中…" : "更新密码"}</button></footer></form></aside></div>;
}
