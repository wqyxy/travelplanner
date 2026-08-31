import type { PlaceResolverV2 } from "./place-resolver-v2.js";

/**
 * Keeps v3 orchestration on the existing Place Resolver fact chain. This adapter
 * only normalizes method names; it does not add a second resolution system.
 */
export class PlaceResolverAdapterV3 {
  constructor(private readonly delegate: PlaceResolverV2) {}
  resolve(...args: Parameters<PlaceResolverV2["resolve"]>) { return this.delegate.resolve(...args); }
  resolveMany(...args: Parameters<PlaceResolverV2["resolveMany"]>) { return this.delegate.resolveMany(...args); }
  searchCandidates(...args: Parameters<PlaceResolverV2["searchCandidates"]>) { return this.delegate.searchCandidates(...args); }
  selectCandidate(...args: Parameters<PlaceResolverV2["selectProviderCandidate"]>) { return this.delegate.selectProviderCandidate(...args); }
  setDirect(...args: Parameters<PlaceResolverV2["setDirectCoordinates"]>) { return this.delegate.setDirectCoordinates(...args); }
  preview(...args: Parameters<PlaceResolverV2["preview"]>) { return this.delegate.preview(...args); }
  commitPreviewLatest(...args: Parameters<PlaceResolverV2["commitPreviewLatest"]>) { return this.delegate.commitPreviewLatest(...args); }
}
