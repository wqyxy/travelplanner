import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : "页面运行异常" }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Travel Planner UI error", error, info.componentStack); }
  render() { return this.state.error ? <main className="loading-screen"><section className="auth-card"><h1>页面遇到问题</h1><p>{this.state.error}</p><button className="button primary" onClick={() => location.reload()}>重新加载</button></section></main> : this.props.children; }
}

createRoot(document.getElementById("root")!).render(<StrictMode><AppErrorBoundary><App/></AppErrorBoundary></StrictMode>);
