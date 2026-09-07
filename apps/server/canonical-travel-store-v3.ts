import { TravelPlanDocumentSchema } from "./contracts-v2.js";
import { canonicalizePlanWriteV3 } from "./canonical-plan-write-v3.js";
import { TravelStoreV3 } from "./travel-store-v3.js";

function canonicalPlanForTrip(store: TravelStoreV3, tripId: string, planValue: unknown) {
  const before = store.requireTrip(tripId).plan;
  return canonicalizePlanWriteV3(before, TravelPlanDocumentSchema.parse(planValue));
}

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
    const plan = canonicalPlanForTrip(this, tripId, planValue);
    return super.writePlan(...([tripId, plan, ...rest] as Parameters<TravelStoreV3["writePlan"]>));
  }

  override writePlanAndPlaceResolution(
    ...args: Parameters<TravelStoreV3["writePlanAndPlaceResolution"]>
  ): ReturnType<TravelStoreV3["writePlanAndPlaceResolution"]> {
    const [tripId, planValue, ...rest] = args;
    const plan = canonicalPlanForTrip(this, tripId, planValue);
    return super.writePlanAndPlaceResolution(...([tripId, plan, ...rest] as Parameters<TravelStoreV3["writePlanAndPlaceResolution"]>));
  }

  override applyProposalPlan(...args: Parameters<TravelStoreV3["applyProposalPlan"]>): ReturnType<TravelStoreV3["applyProposalPlan"]> {
    const [proposalId, planValue, ...rest] = args;
    const proposal = this.getProposal(proposalId);
    if (!proposal) return super.applyProposalPlan(...args);
    const plan = canonicalPlanForTrip(this, proposal.tripId, planValue);
    return super.applyProposalPlan(...([proposalId, plan, ...rest] as Parameters<TravelStoreV3["applyProposalPlan"]>));
  }
}

const installedPrototypes = new WeakSet<object>();

/**
 * Transitional runtime installer used by index-cutover-v3.ts.
 *
 * The application currently constructs TravelStoreV3 inside index-v3.ts. Until
 * that larger entrypoint is safely rewritten, install the same canonical write
 * policy on the existing prototype before index-v3.ts is dynamically imported.
 * Original methods are captured first, so transaction/CAS behavior remains the
 * exact TravelStoreV3 implementation and this wrapper cannot recurse.
 */
export function installCanonicalTravelStoreWriteBoundaryV3() {
  const prototype = TravelStoreV3.prototype;
  if (installedPrototypes.has(prototype)) return;

  const originalWritePlan = prototype.writePlan;
  const originalWritePlanAndPlaceResolution = prototype.writePlanAndPlaceResolution;
  const originalApplyProposalPlan = prototype.applyProposalPlan;

  prototype.writePlan = function (...args: Parameters<TravelStoreV3["writePlan"]>) {
    const [tripId, planValue, ...rest] = args;
    const plan = canonicalPlanForTrip(this, tripId, planValue);
    return originalWritePlan.apply(this, [tripId, plan, ...rest] as Parameters<TravelStoreV3["writePlan"]>);
  };

  prototype.writePlanAndPlaceResolution = function (
    ...args: Parameters<TravelStoreV3["writePlanAndPlaceResolution"]>
  ) {
    const [tripId, planValue, ...rest] = args;
    const plan = canonicalPlanForTrip(this, tripId, planValue);
    return originalWritePlanAndPlaceResolution.apply(
      this,
      [tripId, plan, ...rest] as Parameters<TravelStoreV3["writePlanAndPlaceResolution"]>,
    );
  };

  prototype.applyProposalPlan = function (...args: Parameters<TravelStoreV3["applyProposalPlan"]>) {
    const [proposalId, planValue, ...rest] = args;
    const proposal = this.getProposal(proposalId);
    if (!proposal) return originalApplyProposalPlan.apply(this, args);
    const plan = canonicalPlanForTrip(this, proposal.tripId, planValue);
    return originalApplyProposalPlan.apply(
      this,
      [proposalId, plan, ...rest] as Parameters<TravelStoreV3["applyProposalPlan"]>,
    );
  };

  installedPrototypes.add(prototype);
}