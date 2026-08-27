from pathlib import Path

path = Path('apps/web/src/workspace-v2.test.ts')
s = path.read_text(encoding='utf-8')
old = '    routes: [], routeStates: [], proposals: [], messages: [], tasks: [], revisions: [],\n'
new = '    routes: [], routeStates: [], proposals: [], messages: [], tasks: [], revisions: [], coverage: [],\n'
if s.count(old) != 1:
    raise SystemExit(f'workspace coverage fixture: expected one match, found {s.count(old)}')
s = s.replace(old, new, 1)
path.write_text(s, encoding='utf-8')
print('layered typecheck fixture fixes applied')
