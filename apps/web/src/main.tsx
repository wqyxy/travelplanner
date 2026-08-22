import { Component, StrictMode, type ErrorInfo, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { KeyRound } from "lucide-react";
import { PasswordDrawer } from "./PasswordDrawer";

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : "页面运行异常" }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Travel Planner UI error", error, info.componentStack); }
  render() { return this.state.error ? <main className="loading-screen"><section className="auth-card"><h1>页面遇到问题</h1><p>{this.state.error}</p><button className="button primary" onClick={() => location.reload()}>重新加载</button></section></main> : this.props.children; }
}

function PasswordShortcut() {
  const [open, setOpen] = useState(false); const [visible, setVisible] = useState(false);
  useEffect(() => { let active = true; const update = (event: Event) => setVisible(Boolean((event as CustomEvent<boolean>).detail)); window.addEventListener("travel-auth.changed", update); void fetch("/api/bootstrap").then((response) => response.json()).then((payload) => { if (active) setVisible(Boolean(payload?.data?.authenticated)); }).catch(() => undefined); return () => { active = false; window.removeEventListener("travel-auth.changed", update); }; }, []);
  if (!visible) return null;
  return <><button className="password-shortcut" type="button" aria-label="修改密码" onClick={() => setOpen(true)}><KeyRound size={14}/>修改密码</button><PasswordDrawer open={open} onClose={() => setOpen(false)}/></>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><AppErrorBoundary><App/><PasswordShortcut/></AppErrorBoundary></StrictMode>);
