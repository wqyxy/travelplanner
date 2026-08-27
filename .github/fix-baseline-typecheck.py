from pathlib import Path


def replace_once(value: str, old: str, new: str, label: str) -> str:
    count = value.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return value.replace(old, new, 1)


path = Path("apps/server/planner-runtime-core-v2.ts")
s = path.read_text(encoding="utf-8")
s = replace_once(
    s,
    '        this.emit("travel.proposal.changed", { tripId, proposalId });',
    '        this.emit("travel.proposal.changed", { tripId, proposalId: proposal.id });',
    "proposal event id",
)
path.write_text(s, encoding="utf-8")

path = Path("apps/server/planner-runtime-v2.ts")
s = path.read_text(encoding="utf-8")
s = replace_once(s, '  private async resolveChangedPlaces(', '  private async resolveChangedPlacesAfterMutation(', "subclass resolver rename")
count = s.count('this.resolveChangedPlaces(')
if count < 1:
    raise SystemExit("subclass resolver calls not found")
s = s.replace('this.resolveChangedPlaces(', 'this.resolveChangedPlacesAfterMutation(')
path.write_text(s, encoding="utf-8")

print("baseline typecheck blockers fixed")
