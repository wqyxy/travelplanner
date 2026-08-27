from pathlib import Path

path = Path('.github/apply-layered-planning.py')
s = path.read_text(encoding='utf-8')
marker = '# Tests/fixtures: required nullable field + explicit-parent/Coverage regression.'
start = s.index(marker)
head = s[:start]
tail = r"""# Tests/fixtures: required nullable field + explicit-parent/Coverage regression.
# ---------------------------------------------------------------------------
# Patch the planning-area helper explicitly so function parameter types are
# never touched by the generic fixture updater.
path = "apps/server/planning-areas-v2.test.ts"
s = read(path)
s = replace_once(s, 'import { buildPlanningAreaContext, fulfilledMacroCityCandidateIds } from "./planning-areas-v2.js";', 'import { buildPlanningAreaContext, buildPlanningCoverage, fulfilledMacroCityCandidateIds } from "./planning-areas-v2.js";', "planning test coverage import")
s = replace_once(
    s,
    'const candidate = (id: string, placeId: string, preference: "must_go" | "want_to_go" | "optional" | "excluded") => ({ id, placeId, preference });',
    'const candidate = (id: string, placeId: string, preference: "must_go" | "want_to_go" | "optional" | "excluded", planningAreaCandidateId: string | null = null) => ({ id, placeId, planningAreaCandidateId, preference });',
    "planning test candidate helper",
)
append = r'''

  it("uses explicit Macro relation even when Micro city text does not match", () => {
    const plan = {
      places: [
        place("franz", "弗朗茨·约瑟夫冰川地区", "city", "Franz Josef"),
        { ...place("glacier", "Franz Josef Glacier Walk", "attraction", "Westland"), region: "West Coast" },
      ],
      candidates: [
        candidate("franz-c", "franz", "must_go"),
        candidate("glacier-c", "glacier", "optional", "franz-c"),
      ],
    };
    const context = buildPlanningAreaContext(plan);
    expect(context.areas).toHaveLength(1);
    expect(context.areas[0].cityCandidateId).toBe("franz-c");
    expect(context.areas[0].childCandidateIds).toEqual(["glacier-c"]);
    expect(buildPlanningCoverage(plan, new Set(["glacier"]))[0]).toMatchObject({
      macroCandidateId: "franz-c",
      participatingResolvedMicroCount: 1,
      status: "ready",
    });
  });
'''
s = replace_once(s, "\n});\n", append + "\n});\n", "planning explicit relation regression")
write(path, s)

for test_path in Path("apps").rglob("*.test.ts"):
    if test_path.as_posix() == "apps/server/planning-areas-v2.test.ts":
        continue
    value = test_path.read_text(encoding="utf-8")
    # Candidate object fields, but not TypeScript function/type annotations.
    value = re.sub(r'(placeId:\s*(?!string\b)[^,\n]+,\s*)(preference:)', r'\1planningAreaCandidateId: null, \2', value)
    value = re.sub(r'(?<!planningAreaCandidateId: null, )defaultPreference:\s*"optional"', 'planningAreaCandidateId: null, defaultPreference: "optional"', value)
    test_path.write_text(value, encoding="utf-8")

print("layered Macro/Micro planning transformations applied")
"""
path.write_text(head + marker + '\n' + tail, encoding='utf-8')
print('layered implementation script prepared')
