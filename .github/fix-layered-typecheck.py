from pathlib import Path

path = Path('apps/web/src/workspace-v2.test.ts')
s = path.read_text(encoding='utf-8')
old = '    routes: [], routeStates: [], proposals: [], messages: [], tasks: [], revisions: [],\n'
new = '    routes: [], routeStates: [], proposals: [], messages: [], tasks: [], revisions: [], coverage: [],\n'
if s.count(old) != 1:
    raise SystemExit(f'workspace coverage fixture: expected one match, found {s.count(old)}')
s = s.replace(old, new, 1)
path.write_text(s, encoding='utf-8')

path = Path('apps/server/contracts-v2.test.ts')
s = path.read_text(encoding='utf-8')
old = 'const candidate = (id: string, placeId: string, preference: "must_go" | "want_to_go" | "optional" | "excluded" = "optional") => ({ id, placeId, preference, source: "ai" as const, aiReason: "推荐", aiScore: 80, suggestedDurationMinutes: 90, tags: [] });\n'
new = 'const candidate = (id: string, placeId: string, preference: "must_go" | "want_to_go" | "optional" | "excluded" = "optional", planningAreaCandidateId: string | null = null) => ({ id, placeId, planningAreaCandidateId, preference, source: "ai" as const, aiReason: "推荐", aiScore: 80, suggestedDurationMinutes: 90, tags: [] });\n'
if s.count(old) != 1:
    raise SystemExit(f'contract candidate helper: expected one match, found {s.count(old)}')
s = s.replace(old, new, 1)
path.write_text(s, encoding='utf-8')

print('layered typecheck fixture fixes applied')
