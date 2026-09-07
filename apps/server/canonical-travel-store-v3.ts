import { TravelPlanDocumentSchema, type TravelPlanDocument } from "./contracts-v2.js";
import { canonicalizePlanWriteV3 } from "./canonical-plan-write-v3.js";
import { TravelStoreV3 } from "./travel-store-v3.js";

const INSTALL_FLAG = "__travelPlannerCanonicalStoreWriteBoundaryV3";

function canonicalPlan(before: TravelPlanDocument, planValue: unknown) {
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
    const [tripId, planValue, expectedGeneration, ...rest] = args;
    const current = this.requireTrip(tripId);
    if (current.contentGeneration !== expectedGeneration) return super.writePlan(...args);
    const plan = canonicalPlan(current.plan, planValue);
    return super.writePlan(...([tripId, plan, expectedGeneration, ...rest] as Parameters<TravelStoreV3["writePlan"]>));
  }

  override writePlanAndPlaceResolution(
    ...args: Parameters<TravelStoreV3["writePlanAndPlaceResolution"]>
  ): ReturnType<TravelStoreV3["writePlanAndPlaceResolution"]> {
    const [tripId, planValue, resolutionValue, expectedGeneration, ...rest] = args;
    const current = this.requireTrip(tripId);
    if (current.contentGeneration !== expectedGeneration) return super.writePlanAndPlaceResolution(...args);
    const plan = canonicalPlan(current.plan, planValue);
    return super.writePlanAndPlaceResolution(...([
      tripId,
      plan,
      resolutionValue,
      expectedGeneration,
      ...rest,
    ] as Parameters<TravelStoreV3["writePlanAndPlaceResolution"]>));
  }

  override applyProposalPlan(...args: Parameters<TravelStoreV3["applyProposalPlan"]>): ReturnType<TravelStoreV3["applyProposalPlan"]> {
    const [proposalId, planValue, ...rest] = args;
    const proposal = this.getProposal(proposalId);
    if (!proposal || proposal.status !== "pending") return super.applyProposalPlan(...args);
    const current = this.requireTrip(proposal.tripId);
    if (current.contentGeneration !== proposal.baseGeneration) return super.applyProposalPlan(...args);
    const plan = canonicalPlan(current.plan, planValue);
    return super.applyProposalPlan(...([proposalId, plan, ...rest] as Parameters<TravelStoreV3["applyProposalPlan"]>));
  }
}

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
  const prototypeRecord = prototype as unknown as Record<string, unknown>;
  if (prototypeRecord[INSTALL_FLAG] === true) return;

  const originalWritePlan = prototype.writePlan;
  const originalWritePlanAndPlaceResolution = prototype.writePlanAndPlaceResolution;
  const originalApplyProposalPlan = prototype.applyProposalPlan;

  prototype.writePlan = function (...args: Parameters<TravelStoreV3["writePlan"]>) {
    const [tripId, planValue, expectedGeneration, ...rest] = args;
    const current = this.requireTrip(tripId);
    if (current.contentGeneration !== expectedGeneration) return originalWritePlan.apply(this, args);
    const plan = canonicalPlan(current.plan, planValue);
    return originalWritePlan.apply(
      this,
      [tripId, plan, expectedGeneration, ...rest] as Parameters<TravelStoreV3["writePlan"]>,
    );
  };

  prototype.writePlanAndPlaceResolution = function (
    ...args: Parameters<TravelStoreV3["writePlanAndPlaceResolution"]>
  ) {
    const [tripId, planValue, resolutionValue, expectedGeneration, ...rest] = args;
    const current = this.requireTrip(tripId);
    if (current.contentGeneration !== expectedGeneration) {
      return originalWritePlanAndPlaceResolution.apply(this, args);
    }
    const plan = canonicalPlan(current.plan, planValue);
    return originalWritePlanAndPlaceResolution.apply(
      this,
      [tripId, plan, resolutionValue, expectedGeneration, ...rest] as Parameters<TravelStoreV3["writePlanAndPlaceResolution"]>,
    );
  };

  prototype.applyProposalPlan = function (...args: Parameters<TravelStoreV3["applyProposalPlan"]>) {
    const [proposalId, planValue, ...rest] = args;
    const proposal = this.getProposal(proposalId);
    if (!proposal || proposal.status !== "pending") return originalApplyProposalPlan.apply(this, args);
    const current = this.requireTrip(proposal.tripId);
    if (current.contentGeneration !== proposal.baseGeneration) return originalApplyProposalPlan.apply(this, args);
    const plan = canonicalPlan(current.plan, planValue);
    return originalApplyProposalPlan.apply(
      this,
      [proposalId, plan, ...rest] as Parameters<TravelStoreV3["applyProposalPlan"]>,
    );
  };

  Object.defineProperty(prototype, INSTALL_FLAG, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}