const ENGINEERING_TEXT_V3 = /(?:\bplanningRole\b|\bplanningAreaCandidateId\b|\bstayBlockId\b|\bfingerprint\b|\bmacroBasisFingerprint\b|\bmacroDirty\b|\baffectedDayIds\b|\bWorkflowStep\b|\bConversationStage\b|\brequiresWorkflowStep\b|\bCAS\b|\bResolution\b|\bgeneration\b|\btargetIds\b|\bexecutor\b|\bscope\b|\bCandidate Pool\b|\bCandidate ID\b|\bStop ID\b|\bCandidate\b|\bPlace\b|\bAnchor\b|\bMacro\b|\bproviderPlaceId\b|\bgeoFingerprint\b|CONTENT_GENERATION|(?:destination|interest|itinerary)\.[a-z0-9_.-]+)/iu;

export function containsEngineeringTextV3(value: string | null | undefined) {
  return Boolean(value && ENGINEERING_TEXT_V3.test(value));
}

export function publicSafeTextV3(value: string | null | undefined, fallback: string) {
  const text = value?.trim() ?? "";
  if (!text || containsEngineeringTextV3(text)) return fallback;
  return text;
}
