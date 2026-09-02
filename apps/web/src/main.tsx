import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import mapLibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "./styles.css";
import "./v3-fixes.css";
import "./workspace-v4.css";
import "./stage-ai-v3.css";
import "./phase6-workflow.css";
import AppWorkflowV3 from "./AppWorkflowV3";

setWorkerUrl(mapLibreWorkerUrl);

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : "页面运行异常" }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Travel Planner UI error", error, info.componentStack); }
  render() {
    return this.state.error
      ? <main className="loading-screen"><section className="auth-card"><h1>页面遇到问题</h1><p>{this.state.error}</p><button className="button primary" onClick={() => location.reload()}>重新加载</button></section></main>
      : this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(<StrictMode><AppErrorBoundary><AppWorkflowV3/></AppErrorBoundary></StrictMode>);
