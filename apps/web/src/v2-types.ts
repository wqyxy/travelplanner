export type ItineraryLanguage = "zh" | "en" | "bilingual";
export type TripStage = "place_selection" | "itinerary_planning" | "itinerary_refinement";
export type VerificationStatus = "verified" | "estimated" | "unverified";
export type Verification = { status: VerificationStatus; checkedAt: string | null };
export type PlaceKind = "city" | "attraction" | "lodging" | "meal" | "airport" | "station" | "port" | "stop" | "waypoint";
export type Place = {
  id: string;
  nameZh: string;
  nameLocal: string | null;
  nameEn: string | null;
  kind: PlaceKind;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  approximate: boolean;
};
export type TripFacts = {
  title: string;
  brief: { destination: string; origin: string; departureTime: string; duration: string; travelers: string; transport: string; additionalRequirements: string };
  originPlaceId: string | null;
  destinationPlaceIds: string[];
  dates: { start: string | null; end: string | null; requestedDurationDays: number | null };
  travelers: { summary: string; adults: number | null; children: number | null };
  budget: { amount: number | null; currency: string | null; note: string | null };
  pace: string | null;
  themes: string[];
  preferences: string[];
  constraints: string[];
  assumptions: Array<{ text: string; source: "user" | "ai" | "system"; confidence: "low" | "medium" | "high" }>;
};
export type CandidatePreference = "must_go" | "want_to_go" | "optional" | "excluded";
export type PlanningRole = "planning_area" | "core_visit" | "detail_interest";
export type TripCandidate = {
  id: string;
  placeId: string;
  planningAreaCandidateId: string | null;
  planningRole?: PlanningRole;
  preference: CandidatePreference;
  source: "ai" | "user";
  aiReason: string | null;
  aiScore: number | null;
  suggestedDurationMinutes: number | null;
  tags: string[];
};
export type Period = "morning" | "afternoon" | "evening" | "night" | "all_day";
export type TransportMode = "walk" | "drive" | "bike" | "transit" | "rail" | "flight" | "ferry" | "none";
export type Transport = { mode: TransportMode; durationMinutes: number | null; note: string | null; verification: Verification };
export type DayAnchor = { id: string; placeId: string | null; label: string | null; notes: string | null };
export type DayStop = {
  id: string;
  candidateId: string | null;
  placeId: string;
  activity: string;
  period: Period | null;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number | null;
  transportFromPrevious: Transport | null;
  scheduleVerification: Verification | null;
  costNote: string | null;
  costVerification: Verification | null;
  notes: string | null;
};
export type Day = {
  id: string;
  dayNumber: number;
  date: string | null;
  title: string;
  stayBlockId?: string;
  detailLevel: "planned" | "detailed";
  detailStatus: "ready" | "needs_review" | null;
  startAnchor: DayAnchor;
  stops: DayStop[];
  endAnchor: DayAnchor;
};
export type PlanningState = {
  macroBasisVersion: 1;
  macroBasisFingerprint: string | null;
};
export type TravelPlanDocument = {
  schemaVersion: 2;
  stage: TripStage;
  trip: TripFacts;
  places: Place[];
  candidates: TripCandidate[];
  days: Day[];
  planningState?: PlanningState;
  warnings: string[];
};
export type Trip = {
  id: string;
  title: string;
  state: "active" | "trashed";
  updatedAt: string;
  planLanguage: ItineraryLanguage;
  contentGeneration: number;
  plan: TravelPlanDocument;
  codexThreadId?: string | null;
};
export type Chat = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reply: Record<string, unknown> | null;
  status: "pending" | "completed" | "failed";
  turn: {
    status: "queued" | "starting" | "active" | "completed" | "failed" | "interrupted";
    cancelRequested: boolean;
    errorMessage: string | null;
    progressMessage: string | null;
    codexTurnId: string | null;
  } | null;
  createdAt: string;
};
export type AiProgressEvent = { id: number; taskId: string; tripId: string; agent: "planner" | "detailer" | "map"; status: string; kind: string; summary: string; createdAt: string };
export type AiTask = {
  id: string;
  tripId: string;
  agent: "planner" | "detailer" | "map";
  label: string;
  status: "starting" | "running" | "waiting" | "reconnecting" | "completed" | "failed" | "stopped" | "cancelled_by_generation";
  summary: string;
  startedAt: string;
  updatedAt: string;
  canStop: boolean;
  retryCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  metadata?: Record<string, unknown>;
  events: AiProgressEvent[];
};
export type PlaceResolution = {
  tripId: string;
  placeId: string;
  geoFingerprint: string;
  status: "resolving" | "resolved" | "unresolved";
  method: "provider_match" | "provider_choice" | "map_pick" | "manual_coordinates" | "google_maps_link";
  provider: string | null;
  providerPlaceId: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  confidence: number | null;
  resolvedAt: string | null;
  errorMessage: string | null;
};
export type ProviderPlaceCandidate = {
  provider: string;
  providerPlaceId: string;
  name: string | null;
  displayName: string;
  latitude: number;
  longitude: number;
  category: string | null;
  placeType: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
};
export type RouteLeg = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  fromPlaceId: string;
  toPlaceId: string;
  mode: TransportMode;
  status: "ready" | "attention";
  distanceKm: number | null;
  durationMinutes: number | null;
  geometry: GeoJsonGeometry | null;
  warning: string | null;
};
export type GeoJsonGeometry = { type: string; coordinates: unknown };
export type DayRoute = {
  tripId: string;
  dayId: string;
  version: number;
  inputFingerprint: string;
  status: "idle" | "calculating" | "ready" | "attention";
  distanceKm: number | null;
  durationMinutes: number | null;
  geometry: unknown | null;
  legs: RouteLeg[];
  warnings: string[];
  calculatedAt: string | null;
};
export type RouteState = { dayId: string; dirty: boolean; route: DayRoute | null };
export type ProposalScope =
  | { type: "candidate_pool"; id: null }
  | { type: "candidate"; id: string }
  | { type: "place"; id: string }
  | { type: "day"; id: string }
  | { type: "trip"; id: null };
export type DayStopChanges = Partial<Omit<DayStop, "id">>;
export type PlanCommand =
  | { type: "set_candidate_preference"; candidateId: string; preference: CandidatePreference }
  | { type: "bulk_set_candidate_preference"; candidateIds: string[]; preference: CandidatePreference }
  | { type: "add_candidate"; place: Place; candidate: TripCandidate }
  | { type: "remove_candidate"; candidateId: string }
  | { type: "remove_candidate_tree"; candidateId: string }
  | { type: "update_candidate"; candidateId: string; changes: Partial<Pick<TripCandidate, "aiReason" | "aiScore" | "suggestedDurationMinutes" | "tags">> }
  | { type: "update_place"; placeId: string; changes: Partial<Omit<Place, "id">> }
  | { type: "set_day_anchor"; dayId: string; anchor: "start" | "end"; placeId: string | null; label: string | null; notes: string | null }
  | { type: "add_day_stop"; dayId: string; index: number; stop: DayStop }
  | { type: "update_day_stop"; stopId: string; changes: DayStopChanges }
  | { type: "move_day_stop"; stopId: string; targetDayId: string; targetIndex: number }
  | { type: "remove_day_stop"; stopId: string }
  | { type: "move_day"; dayId: string; targetIndex: number }
  | { type: "update_day"; dayId: string; changes: Partial<Pick<Day, "title" | "date">> };
export type AiProposal = {
  id: string;
  tripId: string;
  baseGeneration: number;
  scope: ProposalScope;
  status: "pending" | "applied" | "rejected" | "superseded" | "undone";
  title: string;
  explanation: string;
  commands: PlanCommand[];
  diff: { summary: string; commandSummaries: string[]; affectedCandidateIds: string[]; affectedPlaceIds: string[]; affectedDayIds: string[] };
  createdAt: string;
  updatedAt: string;
  appliedRevisionVersion: number | null;
};
export type Revision = { version: number; createdAt: string; source: string; summary: string };
export type PlanningCoverageStatus = "ready" | "attention" | "blocked";
export type PlanningAreaCoverage = {
  areaKey: string;
  label: string;
  macroCandidateId: string;
  preference: CandidatePreference;
  microCandidateCount: number;
  resolvedMicroCount: number;
  participatingResolvedMicroCount: number;
  status: PlanningCoverageStatus;
};
export type Workspace = {
  trip: Trip;
  resolutions: PlaceResolution[];
  routes: DayRoute[];
  proposals: AiProposal[];
  routeStates: RouteState[];
  messages: Chat[];
  tasks: AiTask[];
  revisions: Revision[];
  coverage: PlanningAreaCoverage[];
};
export type WorkspaceSelection =
  | { type: "trip"; id: null }
  | { type: "candidate_pool"; id: null }
  | { type: "candidate"; id: string }
  | { type: "place"; id: string }
  | { type: "day"; id: string }
  | { type: "stop"; id: string };
export type UiSettings = { workspaceSplitRatio: number; theme: "light" | "dark"; sidebarOpen: boolean; mapCategoryColors: Record<string, string> };
export type AppSettings = { ai: { model: string; reasoningEffort: string }; ui: UiSettings };
