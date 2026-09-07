import { TravelPlanDocumentSchema } from "./contracts-v2.js";
import { canonicalizePlanWriteV3 } from "./canonical-plan-write-v3.js";
import { TravelStoreV3 } from "./travel-store-v3.js";

/**
 * Application-facing V3 store boundary.
 *
 * SQLite persistence, transactions, generation CAS, revisions, proposals and
 * undo remain implemented by TravelStoreV3. This class only normalizes plan
 * values at public write entry points so callers cannot persist an independent
 * Day route structure once finalRoute is canonical.
 */
export class CanonicalTravelStoreV3 extends TravelStoreV3 {
  override writePlan(...args: Parameters<TravelStoreV3["writePlan"]>): ReturnType<TravelStoreV3["writePlan"]> {
    const [tripId, planValue, ...rest] = args;
    const before = this.requireTrip(tripId).plan;
    const plan = canonicalizePlanWriteV3(before, TravelPlanDocumentSchema.parse(planValue));
    return super.writePlan(...([tripId, plan, ...rest] as Parameters<TravelStoreV3["writePlan"]>));
  }

  override writePlanAndPlaceResolution(
    ...args: Parameters<TravelStoreV3["writePlanAndPlaceResolution"]>
  ): ReturnType<TravelStoreV3["writePlanAndPlaceResolution"]> {
    const [tripId, planValue, ...rest] = args;
    const before = this.requireTrip(tripId).plan;
    const plan = canonicalizePlanWriteV3(before, TravelPlanDocumentSchema.parse(planValue));
    return super.writePlanAndPlaceResolution(...([tripId, plan, ...rest] as Parameters<TravelStoreV3["writePlanAndPlaceResolution"]>));
  }

  override applyProposalPlan(...args: Parameters<TravelStoreV3["applyProposalPlan"]>): ReturnType<TravelStoreV3["applyProposalPlan"]> {
    const [proposalId, planValue, ...rest] = args;
    const proposal = this.getProposal(proposalId);
    if (!proposal) return super.applyProposalPlan(...args);
    const before = this.requireTrip(proposal.tripId).plan;
    const plan = canonicalizePlanWriteV3(before, TravelPlanDocumentSchema.parse(planValue));
    return super.applyProposalPlan(...([proposalId, plan, ...rest] as Parameters<TravelStoreV3["applyProposalPlan"]>));
  }
}
