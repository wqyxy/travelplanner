import type { PlaceResolverV2 } from "./place-resolver-v2.js";

/**
 * Planner-facing resolver capability.
 *
 * The provider implementation may remain PlaceResolverV2; Runtime only depends
 * on the operations it actually needs, including the two user-authorized alias
 * names exposed by index-v3.ts.
 */
export type PlannerPlaceResolverCapabilityV3 = Pick<
  PlaceResolverV2,
  "resolveMany" | "searchCandidates"
> & {
  selectCandidate: PlaceResolverV2["selectProviderCandidate"];
  setDirect: PlaceResolverV2["setDirectCoordinates"];
};
