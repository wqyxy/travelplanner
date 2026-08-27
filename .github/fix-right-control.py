from pathlib import Path


def replace_once(value: str, old: str, new: str, label: str) -> str:
    count = value.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return value.replace(old, new, 1)


path = Path("apps/web/src/App.tsx")
s = path.read_text(encoding="utf-8")
s = replace_once(
    s,
    'import { History, KeyRound, Menu, Moon, Plus, RefreshCw, Sun, Trash2 } from "lucide-react";',
    'import { History, KeyRound, Menu, Moon, Plus, RefreshCw, Sparkles, Sun, Trash2 } from "lucide-react";',
    "Sparkles import",
)
s = replace_once(
    s,
    '        <div className="workspace-side-v3">\n          <header className="workspace-flow-head-v3">',
    '        <div className="workspace-side-v3">\n          {workspace ? <>\n          <header className="workspace-flow-head-v3">',
    "workspace null guard start",
)
s = replace_once(
    s,
    '          <WorkspaceAssistantV2 title={trip?.title || null} workspace={workspace} selection={selection} chat={messages} busy={working} error={error} onSend={send} onCreateProposal={createProposal} onProposalAction={proposalAction} onStop={stopLatestTask}/>\n        </div>\n      </div></div>',
    '          <WorkspaceAssistantV2 title={trip?.title || null} workspace={workspace} selection={selection} chat={messages} busy={working} error={error} onSend={send} onCreateProposal={createProposal} onProposalAction={proposalAction} onStop={stopLatestTask}/>\n          </> : <div className="workspace-empty-v3"><span className="brand-mark">✦</span><h2>选择一趟旅行</h2><p>所有规划操作都会出现在这个右侧控制台。</p></div>}\n        </div>\n      </div></div>',
    "workspace null guard end",
)
path.write_text(s, encoding="utf-8")

path = Path("apps/web/src/ItineraryPanelV2.tsx")
s = path.read_text(encoding="utf-8")
s = replace_once(s, '            <button className="button small ghost" onClick={onOpenCandidates}>管理地点池</button>\n', '', "remove duplicate candidate navigation")
path.write_text(s, encoding="utf-8")

print("right-control type fixes applied")
