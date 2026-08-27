from pathlib import Path

path = Path('.github/apply-layered-planning.py')
s = path.read_text(encoding='utf-8')
s = s.replace(
    "value = re.sub(r'(placeId:\\s*[^,\\n]+,\\s*)(preference:)', r'\\1planningAreaCandidateId: null, \\2', value)",
    "value = re.sub(r'(placeId:\\s*(?!string\\b)[^,\\n]+,\\s*)(preference:)', r'\\1planningAreaCandidateId: null, \\2', value)",
)
s = s.replace(
    "'const candidate = (id: string, placeId: string, preference: \\"must_go\\" | \\"want_to_go\\" | \\"optional\\" | \\"excluded\\") => ({ id, placeId, planningAreaCandidateId: null, preference });',",
    "'const candidate = (id: string, placeId: string, preference: \\"must_go\\" | \\"want_to_go\\" | \\"optional\\" | \\"excluded\\") => ({ id, placeId, preference });',",
)
path.write_text(s, encoding='utf-8')
print('layered implementation script prepared')
