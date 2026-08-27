from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, value: str) -> None:
    Path(path).write_text(value, encoding="utf-8")


def replace_once(value: str, old: str, new: str, label: str) -> str:
    count = value.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return value.replace(old, new, 1)


# App.tsx: replace the places/itinerary tab model with one four-step right-side workflow.
path = "apps/web/src/App.tsx"
s = read(path)
s = replace_once(s, 'type WorkspaceTab = "places" | "itinerary";\n', 'type WorkspaceStep = "requirements" | "destinations" | "interests" | "itinerary";\n', "workspace step type")
s = replace_once(
    s,
    'const tripStateLabels = { active: "当前行程", trashed: "回收站" } as const;\n',
    'const tripStateLabels = { active: "当前行程", trashed: "回收站" } as const;\n'
    'function defaultWorkspaceStep(workspace: Workspace): WorkspaceStep {\n'
    '  if (workspace.trip.plan.days.length) return "itinerary";\n'
    '  const places = new Map(workspace.trip.plan.places.map((place) => [place.id, place]));\n'
    '  if (workspace.trip.plan.candidates.some((candidate) => places.get(candidate.placeId)?.kind !== "city")) return "interests";\n'
    '  if (workspace.trip.plan.candidates.length) return "destinations";\n'
    '  return "requirements";\n'
    '}\n',
    "default workspace step",
)
s = replace_once(s, '  const [tab, setTab] = useState<WorkspaceTab>("places");\n', '  const [step, setStep] = useState<WorkspaceStep>("requirements");\n', "step state")
s = replace_once(
    s,
    '''      if (resetSelection) {\n        if (next.trip.plan.days[0]) {\n          setSelection({ type: "day", id: next.trip.plan.days[0].id });\n          setTab("itinerary");\n        } else {\n          setSelection({ type: "candidate_pool", id: null });\n          setTab("places");\n        }\n      }\n''',
    '''      if (resetSelection) {\n        const nextStep = defaultWorkspaceStep(next);\n        setStep(nextStep);\n        if (nextStep === "itinerary" && next.trip.plan.days[0]) setSelection({ type: "day", id: next.trip.plan.days[0].id });\n        else setSelection({ type: "candidate_pool", id: null });\n      }\n''',
    "load trip default step",
)
s = replace_once(s, '      setTab("itinerary");\n      await refreshWorkspace();', '      setStep("itinerary");\n      await refreshWorkspace();', "plan step transition")
s = replace_once(s, '{trip && <AiTaskTopbar tasks={tasks} onStop={stopTask}/>}<div className="model-status">', '<div className="model-status">', "remove task controls from top header")

old_workspace = re.compile(
    r'''        \{workspace \? <WorkspaceMapV2 .*?\n        <div className="splitter" onPointerDown=\{resize\}/><div className="workspace-side-v3">.*?\n        </div>\n      </div></div>\n      <WorkspaceAssistantV2 .*?/>
''',
    re.S,
)
match = old_workspace.search(s)
if not match:
    raise SystemExit("right workspace block not found")
new_workspace = '''        {workspace ? <WorkspaceMapV2 workspace={workspace} selectedCandidateId={selectedCandidateId} selectedDayId={selectedDayId} selectedStopId={selectedStopId} mapPickPlaceId={mapPickPlaceId} fullscreen={focus === "map"} onSelectCandidate={(candidateId) => {\n          const candidate = workspace.trip.plan.candidates.find((item) => item.id === candidateId);\n          const place = candidate ? workspace.trip.plan.places.find((item) => item.id === candidate.placeId) : null;\n          setSelection({ type: "candidate", id: candidateId });\n          setStep(place?.kind === "city" ? "destinations" : "interests");\n        }} onSelectStop={(stopId) => { setSelection({ type: "stop", id: stopId }); setStep("itinerary"); }} onMapPick={(placeId, latitude, longitude) => void setManualResolution(placeId, latitude, longitude, null, "map_pick")} onToggleFullscreen={() => setFocus((current) => current === "map" ? null : "map")}/> : <section className="workspace-map-v2 no-trip"><div className="map-empty-overlay"><span className="brand-mark">✦</span><strong>地图只展示规划结果</strong><span>所有旅行操作都从右侧开始</span></div></section>}\n        <div className="splitter" onPointerDown={resize}/>\n        <div className="workspace-side-v3">\n          <header className="workspace-flow-head-v3">\n            <nav className="workspace-flow-nav-v3" aria-label="旅行规划步骤">\n              <button type="button" className={step === "requirements" ? "active" : ""} onClick={() => { setStep("requirements"); setSelection({ type: "trip", id: null }); }}><span>1</span>需求</button>\n              <button type="button" className={step === "destinations" ? "active" : ""} disabled={!workspace} onClick={() => { setStep("destinations"); setSelection({ type: "candidate_pool", id: null }); }}><span>2</span>目的地</button>\n              <button type="button" className={step === "interests" ? "active" : ""} disabled={!workspace.trip.plan.candidates.length} onClick={() => { setStep("interests"); setSelection({ type: "candidate_pool", id: null }); }}><span>3</span>兴趣点</button>\n              <button type="button" className={step === "itinerary" ? "active" : ""} disabled={!workspace.trip.plan.days.length} onClick={() => { setStep("itinerary"); if (workspace.trip.plan.days[0]) setSelection({ type: "day", id: workspace.trip.plan.days[0].id }); }}><span>4</span>行程</button>\n            </nav>\n            <div className="workspace-flow-tools-v3">\n              <small>{step === "requirements" ? "先告诉 AI 这趟旅行想怎么玩" : step === "destinations" ? "决定这趟旅行去哪些城市或区域" : step === "interests" ? "决定每个目的地具体玩什么" : "查看并调整每天的真实路线"}</small>\n              <select aria-label="地点名称语言" value={workspace.trip.planLanguage} onChange={(event) => void saveLanguage(event.target.value as Trip["planLanguage"])}><option value="zh">中文</option><option value="en">English</option><option value="bilingual">中英对照</option></select>\n            </div>\n          </header>\n          {trip && tasks.length > 0 && <div className="workspace-task-strip-v3"><AiTaskTopbar tasks={tasks} onStop={stopTask}/></div>}\n          <div className="workspace-step-content-v3">\n            {step === "requirements" ? <section className="workspace-requirements-v3">\n              <div><p className="eyebrow">START HERE</p><h2>旅行需求</h2><p>所有操作都在这里开始。先在下方告诉 AI 目的地、天数、同行者、节奏和明确偏好；确认后再生成目的地建议。</p></div>\n              <dl>\n                <div><dt>旅行</dt><dd>{trip?.plan.trip.title || "未命名旅行"}</dd></div>\n                <div><dt>日期 / 天数</dt><dd>{trip?.plan.trip.dates.start && trip.plan.trip.dates.end ? `${trip.plan.trip.dates.start} → ${trip.plan.trip.dates.end}` : trip?.plan.trip.dates.requestedDurationDays ? `${trip.plan.trip.dates.requestedDurationDays} 天` : "待补充"}</dd></div>\n                <div><dt>同行者</dt><dd>{trip?.plan.trip.travelers.summary || "待补充"}</dd></div>\n                <div><dt>节奏</dt><dd>{trip?.plan.trip.pace || "待补充"}</dd></div>\n              </dl>\n              <button className="button primary workspace-primary-cta-v3" type="button" disabled={working || !trip} onClick={() => void (async () => { await discover(); setStep("destinations"); setSelection({ type: "candidate_pool", id: null }); })()}><Sparkles size={15}/>生成目的地建议</button>\n            </section> : step === "destinations" ? <CandidatePanel view="macro" workspace={workspace} selectedCandidateId={selectedCandidateId} busy={working} onSelectCandidate={(candidateId) => setSelection({ type: "candidate", id: candidateId })} onSetPreference={setPreference} onDiscover={discover} onAddCandidate={addCandidate} onContinue={async () => { const places = new Map(workspace.trip.plan.places.map((place) => [place.id, place])); const hasMicro = workspace.trip.plan.candidates.some((candidate) => places.get(candidate.placeId)?.kind !== "city"); if (!hasMicro) await discover(); setStep("interests"); setSelection({ type: "candidate_pool", id: null }); }} onRetry={retryResolutions} onSearchCandidates={searchResolutionCandidates} onSelectResolution={selectResolution} onManualResolution={(placeId, latitude, longitude, address) => setManualResolution(placeId, latitude, longitude, address)} onBeginMapPick={(placeId) => { setMapPickPlaceId(placeId); setFocus("map"); }}/> : step === "interests" ? <CandidatePanel view="micro" workspace={workspace} selectedCandidateId={selectedCandidateId} busy={working} onSelectCandidate={(candidateId) => setSelection({ type: "candidate", id: candidateId })} onSetPreference={setPreference} onDiscover={discover} onAddCandidate={addCandidate} onContinue={generatePlan} onRetry={retryResolutions} onSearchCandidates={searchResolutionCandidates} onSelectResolution={selectResolution} onManualResolution={(placeId, latitude, longitude, address) => setManualResolution(placeId, latitude, longitude, address)} onBeginMapPick={(placeId) => { setMapPickPlaceId(placeId); setFocus("map"); }}/> : <ItineraryPanelV2 workspace={workspace} selectedDayId={selectedDayId} selectedStopId={selectedStopId} busy={working} onSelectDay={(dayId) => setSelection({ type: "day", id: dayId })} onSelectStop={(stopId) => setSelection({ type: "stop", id: stopId })} onRecalculate={recalculateRoute} onRecalculateDirty={recalculateDirtyRoutes} onRefine={refine} onCommand={runPlanCommand}/>}\n          </div>\n          <WorkspaceAssistantV2 title={trip?.title || null} workspace={workspace} selection={selection} chat={messages} busy={working} error={error} onSend={send} onCreateProposal={createProposal} onProposalAction={proposalAction} onStop={stopLatestTask}/>\n        </div>\n      </div></div>\n'''
s = s[:match.start()] + new_workspace + s[match.end():]
if "setTab(" in s or "WorkspaceTab" in s:
    raise SystemExit("App.tsx still contains legacy tab navigation")
write(path, s)


# CandidatePanel.tsx: one panel supports either Macro destinations or Micro interests; all primary actions live in its footer.
path = "apps/web/src/CandidatePanel.tsx"
s = read(path)
s = replace_once(s, 'const emptyCandidateForm = (): NewCandidateForm => ({\n', 'const emptyCandidateForm = (kind: PlaceKind = "attraction"): NewCandidateForm => ({\n', "candidate form factory")
s = replace_once(s, '  kind: "attraction",\n', '  kind,\n', "candidate form kind")
s = replace_once(s, 'export function CandidatePanel({\n  workspace,\n', 'export function CandidatePanel({\n  view,\n  workspace,\n', "candidate view prop destructure")
s = replace_once(s, '  onGenerate,\n', '  onContinue,\n', "candidate continue prop destructure")
s = replace_once(s, '}: {\n  workspace: Workspace;\n', '}: {\n  view: "macro" | "micro";\n  workspace: Workspace;\n', "candidate view prop type")
s = replace_once(s, '  onGenerate: () => Promise<void>;\n', '  onContinue: () => Promise<void>;\n', "candidate continue prop type")
s = replace_once(
    s,
    '  const rows = useMemo(() => candidateRows(workspace), [workspace]);\n  const counts = useMemo(() => candidateCounts(rows), [rows]);\n',
    '  const allRows = useMemo(() => candidateRows(workspace), [workspace]);\n  const rows = useMemo(() => allRows.filter((row) => view === "macro" ? row.place.kind === "city" : row.place.kind !== "city"), [allRows, view]);\n  const counts = useMemo(() => candidateCounts(rows), [rows]);\n  const isMacro = view === "macro";\n',
    "candidate scoped rows",
)
s = s.replace('setNewCandidate(emptyCandidateForm())', 'setNewCandidate(emptyCandidateForm(isMacro ? "city" : "attraction"))')
old_head = '''    <header className="candidate-panel-head">\n      <div><p className="eyebrow">DISCOVER & CURATE</p><h2>地点推荐</h2><small>城市控制宏观路线，具体景点控制城市内行程；调整优先级后可直接生成。</small></div>\n      <div className="candidate-head-actions">\n        <button className="button small" type="button" disabled={busy} onClick={() => setNewCandidate(emptyCandidateForm(isMacro ? "city" : "attraction"))}><Plus size={15}/>手动添加</button>\n        <button className="button small" type="button" disabled={busy} onClick={() => void onDiscover()}><WandSparkles size={15}/>{rows.length ? "补充推荐" : "AI 推荐地点"}</button>\n      </div>\n    </header>\n'''
new_head = '''    <header className="candidate-panel-head">\n      <div><p className="eyebrow">{isMacro ? "DESTINATIONS" : "INTERESTS"}</p><h2>{isMacro ? "目的地" : "详细兴趣点"}</h2><small>{isMacro ? "先决定这趟旅行去哪些城市或区域；这里不安排每天路线。" : "只看实际可访问的景点、住宿和交通节点；完成后再生成按天行程。"}</small></div>\n      <div className="candidate-head-actions"><button className="button small" type="button" disabled={busy} onClick={() => setNewCandidate(emptyCandidateForm(isMacro ? "city" : "attraction"))}><Plus size={15}/>手动添加{isMacro ? "目的地" : "兴趣点"}</button></div>\n    </header>\n'''
s = replace_once(s, old_head, new_head, "candidate header")
empty_pattern = re.compile(r'''      \{!rows\.length && <div className="candidate-empty"><Sparkles size=\{34\}/><h3>.*?</div></div>\}\n''')
if len(empty_pattern.findall(s)) != 1:
    raise SystemExit("candidate empty state match failed")
s = empty_pattern.sub('''      {!rows.length && <div className="candidate-empty"><Sparkles size={34}/><h3>{isMacro ? "还没有目的地建议" : "还没有详细兴趣点"}</h3><p>{isMacro ? "使用下方唯一主操作生成城市 / 区域建议。" : "先在“目的地”步骤确认范围，再从下方生成详细兴趣点。"}</p></div>}\n''', s, count=1)
old_footer = '''    <footer className="candidate-footer">\n      {unresolvedSelected.length > 0 && <button className="button" type="button" disabled={busy} onClick={() => void onRetry(unresolvedSelected.map((row) => row.place.id))}><RefreshCw size={14}/>批量重新定位 {unresolvedSelected.length} 个</button>}\n      <button className="button primary generate-plan" type="button" disabled={busy || !counts.selected || workspace.trip.plan.days.length > 0} onClick={() => void onGenerate()}><Sparkles size={15}/>{workspace.trip.plan.days.length ? "行程已生成" : "生成行程与路线"}</button>\n    </footer>\n'''
new_footer = '''    <footer className="candidate-footer candidate-footer-flow-v3">\n      <div>{!isMacro && unresolvedSelected.length > 0 && <button className="button" type="button" disabled={busy} onClick={() => void onRetry(unresolvedSelected.map((row) => row.place.id))}><RefreshCw size={14}/>批量重新定位 {unresolvedSelected.length} 个</button>}<button className="button" type="button" disabled={busy} onClick={() => void onDiscover()}><WandSparkles size={15}/>{isMacro ? (rows.length ? "重新生成目的地建议" : "生成目的地建议") : (rows.length ? "补充兴趣点" : "生成兴趣点")}</button></div>\n      <button className="button primary generate-plan" type="button" disabled={busy || !counts.selected || (!isMacro && workspace.trip.plan.days.length > 0)} onClick={() => void onContinue()}><Sparkles size={15}/>{isMacro ? "生成详细兴趣点" : workspace.trip.plan.days.length ? "行程已生成" : "生成行程与路线"}</button>\n    </footer>\n'''
s = replace_once(s, old_footer, new_footer, "candidate footer")
s = s.replace('城市 / 区域规划节点', '目的地规划节点')
s = s.replace('城市位置已定位', '目的地位置已定位').replace('城市位置未定位', '目的地位置未定位')
s = s.replace('所属城市已标记为不去', '所属目的地已标记为不去')
write(path, s)


# ItineraryPanelV2.tsx: remove the second navigation system back to places and redundant stage strip.
path = "apps/web/src/ItineraryPanelV2.tsx"
s = read(path)
s = replace_once(s, '  onOpenCandidates,\n', '', "itinerary open candidates destructure")
s = replace_once(s, '  onOpenCandidates: () => void;\n', '', "itinerary open candidates type")
s = replace_once(s, '  if (!plan.days.length) return <section className="itinerary-v2-panel empty"><div><Sparkles size={38}/><h2>先选择地点，再生成按天行程</h2><p>地点池让你先确认“去哪里”；AI 排程只会使用你保留并完成定位的地点。</p><button className="button primary" onClick={onOpenCandidates}>返回地点选择</button></div></section>;\n', '  if (!plan.days.length) return <section className="itinerary-v2-panel empty"><div><Sparkles size={38}/><h2>还没有按天行程</h2><p>请使用右侧顶部“兴趣点”步骤完成地点选择并生成行程。</p></div></section>;\n', "itinerary empty navigation")
stage_badge = re.compile(r'''      <div className="plan-stage-badge">.*?</div>\n''', re.S)
if len(stage_badge.findall(s)) != 1:
    raise SystemExit("itinerary stage badge match failed")
s = stage_badge.sub('', s, count=1)
write(path, s)


# WorkspaceAssistantV2: the right-side composer is visible by default so the first interaction is obvious.
path = "apps/web/src/WorkspaceAssistantV2.tsx"
s = read(path)
s = replace_once(s, '  const [expanded, setExpanded] = useState(false);\n', '  const [expanded, setExpanded] = useState(true);\n', "assistant expanded default")
write(path, s)


# CSS: force all workflow interaction surfaces into the right-side controller.
path = "apps/web/src/v3-fixes.css"
s = read(path)
css = r'''

/* Right-side single-entry workflow (P0) */
.workspace-side-v3 {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.workspace-flow-head-v3 {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--border, rgba(127,127,127,.22));
  background: var(--panel, rgba(255,255,255,.96));
}
.workspace-flow-nav-v3 {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  padding: 10px 12px 6px;
}
.workspace-flow-nav-v3 button {
  min-width: 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--muted, #6b7280);
  padding: 8px 4px;
  font-weight: 650;
  cursor: pointer;
}
.workspace-flow-nav-v3 button span {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  margin-right: 5px;
  border-radius: 999px;
  border: 1px solid currentColor;
  font-size: 11px;
}
.workspace-flow-nav-v3 button.active {
  background: var(--soft-accent, rgba(37,99,235,.10));
  color: var(--accent, #2563eb);
}
.workspace-flow-nav-v3 button:disabled { opacity: .42; cursor: not-allowed; }
.workspace-flow-tools-v3 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px 10px;
  color: var(--muted, #6b7280);
}
.workspace-flow-tools-v3 small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-flow-tools-v3 select { flex: 0 0 auto; }
.workspace-task-strip-v3 { flex: 0 0 auto; padding: 8px 12px 0; }
.workspace-task-strip-v3 .ai-task-topbar { width: 100%; }
.workspace-task-strip-v3 .ai-task-trigger { width: 100%; }
.workspace-step-content-v3 {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.workspace-requirements-v3 {
  display: flex;
  min-height: 100%;
  flex-direction: column;
  gap: 18px;
  padding: 22px 20px;
}
.workspace-requirements-v3 h2 { margin: 4px 0 8px; }
.workspace-requirements-v3 > div > p:last-child { margin: 0; color: var(--muted, #6b7280); line-height: 1.6; }
.workspace-requirements-v3 dl { margin: 0; display: grid; gap: 8px; }
.workspace-requirements-v3 dl div { display: grid; grid-template-columns: 92px 1fr; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border, rgba(127,127,127,.18)); }
.workspace-requirements-v3 dt { color: var(--muted, #6b7280); }
.workspace-requirements-v3 dd { margin: 0; font-weight: 600; }
.workspace-primary-cta-v3 { margin-top: auto; width: 100%; justify-content: center; }
.candidate-footer-flow-v3 { align-items: center; justify-content: space-between; gap: 10px; }
.candidate-footer-flow-v3 > div { display: flex; gap: 8px; flex-wrap: wrap; }
.workspace-side-v3 > .assistant-bar-v2,
.workspace-side-v3 > .assistant-drawer-v2 {
  position: static !important;
  inset: auto !important;
  width: 100% !important;
  max-width: none !important;
  margin: 0 !important;
  border-radius: 0 !important;
  flex: 0 0 auto;
  z-index: 4;
}
.workspace-side-v3 > .assistant-bar-v2 { border-left: 0; border-right: 0; border-bottom: 0; }
.workspace-side-v3 > .assistant-drawer-v2 {
  height: min(420px, 42vh) !important;
  max-height: 48%;
  border-left: 0;
  border-right: 0;
  border-bottom: 0;
  box-shadow: 0 -8px 24px rgba(15, 23, 42, .08);
}
.workspace-side-v3 > .assistant-drawer-v2 .assistant-body { min-height: 0; }
@media (max-width: 900px) {
  .workspace-flow-nav-v3 { gap: 2px; padding-inline: 8px; }
  .workspace-flow-nav-v3 button { font-size: 12px; }
  .workspace-flow-nav-v3 button span { display: none; }
  .workspace-flow-tools-v3 small { display: none; }
  .workspace-side-v3 > .assistant-drawer-v2 { height: min(360px, 45vh) !important; }
}
'''
if "Right-side single-entry workflow (P0)" not in s:
    s += css
write(path, s)

print("right-control transformations applied")
