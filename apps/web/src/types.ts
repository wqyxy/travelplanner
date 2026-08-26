export type ItineraryLanguage = "zh" | "en" | "bilingual";
export type VerificationStatus = "verified" | "estimated" | "unverified";
export type Verification = { status: VerificationStatus; checkedAt: string | null };
export type PlaceKind = "city" | "attraction" | "lodging" | "meal" | "airport" | "station" | "port" | "stop" | "waypoint";
export type Place = {
  id: string; nameZh: string; nameLocal: string | null; nameEn: string | null; kind: PlaceKind;
  city: string | null; region: string | null; country: string | null; countryCode: string | null; approximate: boolean;
};
export type Period = "morning" | "afternoon" | "evening" | "night" | "all_day";
export type TransportMode = "walk" | "drive" | "bike" | "transit" | "rail" | "flight" | "ferry" | "none";
export type Stop = {
  id: string; role: "start" | "visit" | "end"; placeId: string; activity: string; period: Period | null;
  startTime: string | null; endTime: string | null; durationMinutes: number | null; scheduleVerification: Verification | null;
  transportFromPrevious: { mode: TransportMode; durationMinutes: number | null; note: string | null; verification: Verification } | null;
  costNote: string | null; costVerification: Verification | null; notes: string | null;
};
export type Day = { id: string; dayNumber: number; date: string | null; title: string; detailLevel: "draft" | "detailed"; detailStatus?: "ready" | "needs_review" | null; stops: Stop[] };
export type Assumption = { text: string; source: "user" | "ai" | "system"; confidence: "low" | "medium" | "high" };
export type Itinerary = {
  schemaVersion: 1; stage: "planning" | "draft" | "detailed";
  trip: {
    title: string; originPlaceId: string | null; destinationPlaceIds: string[];
    dates: { start: string | null; end: string | null; requestedDurationDays: number | null };
    travelers: { summary: string; adults: number | null; children: number | null };
    budget: { amount: number | null; currency: string | null; note: string | null };
    pace: string | null; themes: string[]; preferences: string[]; constraints: string[]; assumptions: Assumption[];
  };
  places: Place[]; days: Day[]; warnings: string[];
};
export type Trip = { id: string; title: string; state: "active" | "trashed"; updatedAt: string; itineraryLanguage: ItineraryLanguage; contentGeneration: number; itinerary: Itinerary };
export type PlannerReply = {
  schemaVersion: 1; operation: "reply" | "mutate_itinerary" | "create_draft" | "start_detailing";
  assistantMessage: string; baseGeneration: number; nextAction: "none" | "start_draft" | "start_detail";
  suggestion: { id: string; text: string } | null;
};
export type Chat = {
  id: string; role: "user" | "assistant"; content: string; reply: PlannerReply | null; status: "pending" | "completed" | "failed";
  turn: { status: "queued" | "starting" | "active" | "completed" | "failed" | "interrupted"; cancelRequested: boolean; errorMessage: string | null; progressMessage: string | null; codexTurnId?: string | null } | null;
  createdAt?: string;
};
export type AiProgressEvent = { id: number; taskId: string; tripId: string; agent: "planner" | "detailer" | "map"; status: string; kind: string; summary: string; createdAt: string };
export type AiTask = {
  id: string; tripId: string; agent: "planner" | "detailer" | "map"; label: string;
  status: "starting" | "running" | "waiting" | "reconnecting" | "completed" | "failed" | "stopped" | "cancelled_by_generation";
  summary: string; startedAt: string; updatedAt: string; canStop: boolean; retryCount: number; nextAttemptAt: string | null; lastError: string | null;
  metadata?: Record<string, unknown>; events: AiProgressEvent[];
};
export type MapVisit = { id: string; dayId: string; dayNumber: number; stopId: string; placeId: string; order: number };
export type MapEdge = { id: string; dayId: string; fromVisitId: string; toVisitId: string; mode: TransportMode; order: number; viaIgnoredVisitIds?: string[]; bridgedTransportMismatch?: boolean };
export type GeoJsonGeometry = { type: string; coordinates: unknown };
export type DerivedMapRoute = { edgeId: string; routeKey: string; geometry: GeoJsonGeometry | null; geometrySource?: "provider" | "straight"; distanceKm?: number | null; durationMinutes?: number | null; status: "ready" | "attention"; warning: string | null };
export type DerivedMapSnapshot = { visits: MapVisit[]; edges: MapEdge[]; routes: DerivedMapRoute[]; visualComplete?: boolean };
export type ResolvedPlace = {
  placeId: string; geoFingerprint: string; provider: string; providerPlaceId: string | null; lat: number | null; lng: number | null;
  timezone: string | null; resolution: "exact" | "approximate" | "researched" | "ignored" | "unresolved"; confidence: number | null; resolvedAt: string | null;
  sourceUrl?: string | null; sourceTitle?: string | null; decisionReason?: string | null;
};
export type MapState = { generation: number; resolvedPlaces: ResolvedPlace[]; map: DerivedMapSnapshot | null; status: "idle" | "syncing" | "ready" | "attention"; warnings: string[]; visualComplete?: boolean; updatedAt: string };
export type UiSettings = { workspaceSplitRatio: number; theme: "light" | "dark"; sidebarOpen: boolean; mapCategoryColors: Record<string, string> };
export type AppSettings = { ai: { model: string; reasoningEffort: string }; ui: UiSettings };
