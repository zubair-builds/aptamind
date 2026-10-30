/**
 * Local, deliberately small TypeScript views of the internal API's JSON responses.
 *
 * The API serialises MongoDB documents, so dates arrive as ISO strings. These types are kept
 * local (instead of importing the domain packages) so the admin stays decoupled from the
 * persistence/domain layers; they only describe the fields the UI renders.
 */

export type Iso = string;
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// ------------------------------------------------------------------ provenance

export type AuthorityTier =
  'official_registry' | 'official_ats' | 'official_site' | 'third_party' | 'operator' | 'inferred';
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'unknown';
export type FactStatus = 'known' | 'unknown' | 'conflicting';

export interface Evidence {
  sourceId: string;
  observationId?: string;
  snapshotId?: string;
  artifactId?: string;
  locator?: string;
  quote?: string;
  observedAt: Iso;
  authority?: AuthorityTier;
  extractor?: { name: string; version: string };
}

export interface Confidence {
  level: ConfidenceLevel;
  score?: number;
  reasons: string[];
}

export interface Fact<T> {
  value: T | null;
  status: FactStatus;
  confidence: Confidence;
  evidence: Evidence[];
  conflicts?: Array<{ value: T | null; evidence: Evidence[]; reason: string }>;
  policyVersion?: string;
  updatedAt?: Iso;
}

/**
 * Cross-domain summary fact (`INTEGRATION_CONTRACTS.md` § Summary convention; Market API v2).
 * `basis` and `alternates` are optional here: API v1 list items carry full facts without them,
 * and the UI then simply omits them.
 */
export interface SummaryFact<T> {
  value: T | null;
  status: FactStatus;
  confidence: { level: ConfidenceLevel; score?: number };
  basis?: string | null;
  alternates?: number;
}

export interface SourceSummary {
  _id: string;
  key?: string;
  name?: string;
  provider?: string;
  authority?: { tier: AuthorityTier; authoritativeFor?: string[]; listingIsComplete?: boolean };
}

export interface AuditEvent {
  _id: string;
  at: Iso;
  actor: { kind: string; id: string };
  action: string;
  entity: { kind: string; id: string };
  reviewItemId?: string;
  runId?: string;
  details: JsonObject;
}

export interface ArtifactRef {
  artifactId: string;
  storageKey: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: Iso;
}

// ------------------------------------------------------------------ sources

export type SourceHealthStatus = 'never_run' | 'healthy' | 'degraded' | 'failing';

export interface Source {
  _id: string;
  key: string;
  name: string;
  category: string;
  provider: string;
  endpoint: { url?: string; boardToken?: string };
  acquisition: {
    workflowKey: string;
    workflowVersion?: number;
    config: JsonObject;
    credentialRefs: Array<{ kind: string; name: string }>;
  };
  companyId?: string;
  /** `null` when the source has no schedule; absent from older API builds. */
  schedule?: {
    cron?: string;
    intervalMinutes?: number;
    timezone: string;
    enabled: boolean;
    nextRunAt: Iso | null;
    lastFiredAt: Iso | null;
  } | null;
  freshness: { policyClass: string; maxAgeMinutes: number };
  authority: { tier: AuthorityTier; authoritativeFor: string[]; listingIsComplete: boolean };
  governance?: {
    accessMethod: string;
    termsNotes?: string;
    commercialUseNotes?: string;
    retentionRestrictions?: string;
    redistributionRestrictions?: string;
    crawlPolicy?: string;
    rateLimitPerMinute?: number;
    lastComplianceReviewAt?: Iso;
  };
  enabled: boolean;
  health: {
    status: SourceHealthStatus;
    consecutiveFailures: number;
    lastAttemptAt?: Iso;
    lastSuccessAt?: Iso;
    lastFailureAt?: Iso;
    lastError?: string;
    lastRunId?: string;
    lastSnapshotId?: string;
    lastCompleteImportStartedAt?: Iso;
    lastItemCount?: number;
  };
  stats?: { attempts: number; successes: number; failures: number };
  labels?: Record<string, string>;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface Snapshot {
  _id: string;
  sourceId: string;
  artifact: ArtifactRef;
  contentHash: string;
  url?: string;
  httpStatus?: number;
  contentType?: string;
  firstFetchedAt: Iso;
  lastFetchedAt: Iso;
  fetchCount: number;
  runIds?: string[];
  via: string;
  itemCount?: number;
}

export interface Schedule {
  _id: string;
  workflowKey: string;
  workflowVersion?: number;
  cron?: string;
  intervalMinutes?: number;
  timezone: string;
  input: JsonObject;
  labels: Record<string, string>;
  enabled: boolean;
  owner?: { kind: string; id: string };
  nextFireAt?: Iso;
  lastFiredAt?: Iso;
  lastRunId?: string;
  lastError?: string;
  fireCount: number;
}

export interface SourceDetail {
  source: Source;
  runs: WorkflowRun[];
  snapshots: Snapshot[];
  schedule: Schedule | null;
  openReviews: ReviewItem[];
  audit: AuditEvent[];
}

// ------------------------------------------------------------------ workflows

export type RunState =
  'PENDING' | 'RUNNING' | 'WAITING' | 'CANCELLING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type NodeState =
  | 'QUEUED'
  | 'RUNNING'
  | 'FANNING_OUT'
  | 'RETRY_SCHEDULED'
  | 'WAITING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED'
  | 'CANCELLED';

export interface ErrorInfo {
  name: string;
  message: string;
  code?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  stack?: string;
}

export interface CapabilityRef {
  type: string;
  version: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export interface WorkflowNode {
  id: string;
  title?: string;
  capability: CapabilityRef;
  config: JsonObject;
  input?: Json;
  retry: RetryPolicy;
  timeoutMs: number;
  queue: string;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  when?: { branch: string };
}

export interface WorkflowDefinition {
  _id: string;
  title: string;
  description: string;
  latestVersion: number;
  labels: Record<string, string>;
  archived: boolean;
  createdAt: Iso;
  updatedAt: Iso;
  schedules: Schedule[];
}

export interface WorkflowVersion {
  _id: string;
  workflowKey: string;
  version: number;
  title: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  inputSchema?: JsonObject;
  outputNode?: string;
  labels: Record<string, string>;
  contentHash: string;
  createdAt: Iso;
}

export interface WorkflowDetail {
  key: string;
  versions: WorkflowVersion[];
  runs: WorkflowRun[];
}

export interface Trigger {
  kind: string;
  actor?: { kind: string; id: string };
  scheduleId?: string;
  scheduledFor?: Iso;
  event?: string;
  data?: JsonObject;
}

export interface WorkflowRun {
  _id: string;
  workflowKey: string;
  workflowVersion: number;
  versionId: string;
  state: RunState;
  input?: JsonObject;
  trigger: Trigger;
  idempotencyKey?: string;
  parent?: { runId: string; nodeRunId: string; itemIndex?: number };
  rootRunId: string;
  depth: number;
  labels: Record<string, string>;
  capabilityVersions: Record<string, string>;
  output?: Json;
  outputRef?: ArtifactRef;
  error?: ErrorInfo;
  failedNodeIds: string[];
  cancelRequestedAt?: Iso;
  startedAt?: Iso;
  finishedAt?: Iso;
  durationMs?: number;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface Attempt {
  attempt: number;
  workerId: string;
  startedAt: Iso;
  finishedAt?: Iso;
  durationMs?: number;
  status: string;
  error?: ErrorInfo;
}

export interface FanoutState {
  totalItems: number;
  totalChunks: number;
  batchSize: number;
  concurrency: number;
  inFlight: number;
  completedChunks: number;
  succeededItems: number;
  failedItems: number;
  failurePolicy: string;
  maxFailureRatio: number;
  bodyCapability?: string;
  bodyWorkflow?: string;
  lastPumpAt?: Iso;
}

export interface WaitInfo {
  kind: string;
  reason: string;
  correlationKey?: string;
  timeoutAt?: Iso;
  data?: JsonObject;
  since: Iso;
}

export interface NodeRunSummary {
  id: string;
  state: NodeState;
  attempt: number;
  maxAttempts: number;
  manualRetries: number;
  attempts: Attempt[];
  input?: Json;
  inputTruncated?: boolean;
  output?: Json;
  outputRef?: ArtifactRef;
  outputPreview?: string;
  error?: ErrorInfo;
  wait?: WaitInfo;
  fanout?: FanoutState;
  startedAt?: Iso;
  finishedAt?: Iso;
  durationMs?: number;
  skipReason?: string;
}

export interface LogEntry {
  at: Iso;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  data?: Record<string, unknown>;
}

export interface NodeRun extends Omit<NodeRunSummary, 'id'> {
  _id: string;
  runId: string;
  rootRunId: string;
  workflowKey: string;
  nodeId: string;
  capability: CapabilityRef;
  queue: string;
  idempotencyKey: string;
  resumeCount: number;
  resumePayload?: JsonObject;
  leaseOwner?: string;
  leaseExpiresAt?: Iso;
  nextAttemptAt?: Iso;
  dispatchedAt?: Iso;
  logs: LogEntry[];
  createdAt: Iso;
  updatedAt: Iso;
}

export interface RunDetailNode {
  nodeId: string;
  title?: string;
  capability: CapabilityRef;
  queue: string;
  retry: RetryPolicy;
  timeoutMs: number;
  config: JsonObject;
  nodeRun: NodeRunSummary | null;
  chunkStates: Record<string, number>;
}

export interface RunDetail {
  run: WorkflowRun;
  version: { id: string; version: number; title: string; edges: WorkflowEdge[] };
  nodes: RunDetailNode[];
  children: Record<string, number>;
  artifacts: ArtifactRef[];
}

export interface FanoutChunk {
  _id: string;
  runId: string;
  nodeRunId: string;
  index: number;
  startIndex: number;
  state: string;
  results: Array<{
    index: number;
    status: string;
    output?: Json;
    error?: ErrorInfo;
    attempts: number;
    childRunId?: string;
  }>;
  attempt: number;
  leaseOwner?: string;
  startedAt?: Iso;
  finishedAt?: Iso;
}

export interface Capability {
  type: string;
  version: number;
  key: string;
  title: string;
  description: string;
  category: string;
  execution: {
    retryable: boolean;
    defaultTimeoutMs?: number;
    idempotency: string;
    sideEffects: boolean;
    queue?: string;
    mode?: string;
  };
  configSchema: unknown;
  inputSchema: unknown;
  outputSchema: unknown;
}

// ------------------------------------------------------------------ companies

export interface Location {
  text?: string;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  kind?: string;
}

export interface Licence {
  register: string;
  country: string;
  route: string;
  typeRating: string | null;
  status: 'listed' | 'no_longer_listed';
  firstSeenAt: Iso;
  lastSeenAt: Iso;
  evidence: Evidence[];
}

export interface Company {
  _id: string;
  status: 'active' | 'merged';
  mergedInto?: string;
  identity: {
    displayName: Fact<string>;
    legalName: Fact<string>;
    normalizedName: string;
    aliases: Array<{ name: string; strictKey: string; sourceIds: string[] }>;
    domain: Fact<string>;
    website: Fact<string>;
    externalIds: Array<{ namespace: string; id: string }>;
    distinctFrom?: string[];
  };
  classification?: {
    industries: Fact<string[]>;
    stage: Fact<string>;
    businessModel: Fact<string>;
    schemes?: Array<{ scheme: string; value: string; confidence: Confidence; evidence: Evidence[] }>;
  };
  firmographics?: {
    foundedYear: Fact<number>;
    employeeEstimate: Fact<number>;
    employeeRange: Fact<{ min: number | null; max: number | null }>;
    fundingStage: Fact<string>;
  };
  geography: {
    headquarters: Fact<Location>;
    offices: Location[];
    registeredLocations: Location[];
    hiringCountries: Fact<string[]>;
  };
  employment: {
    careersUrls: Fact<string[]>;
    ats: Fact<Array<{ provider: string; boardToken: string }>>;
    remotePolicy: Fact<string>;
    sponsorship: CompanySponsorship;
    relocationSupport: Fact<string>;
    eorIndicators: Fact<string[]>;
  };
  quality: {
    observationCount: number;
    sourceIds: string[];
    conflictFields: string[];
    openReviewCount: number;
    lastObservedAt?: Iso;
  };
  freshness: {
    lastReconciledAt?: Iso;
    lastChangedAt?: Iso;
    careersCheckedAt?: Iso;
    careersDiscoveryStatus: string;
  };
  reconciliation?: { logicVersion: string; policyVersion: string; computedAt: Iso; contentHash: string };
  createdAt: Iso;
  updatedAt: Iso;
}

export interface CompanySponsorship {
  capability: Fact<'licensed' | 'previously_licensed'>;
  licenceCountries: string[];
  licences: Licence[];
}

export interface ObservationResolution {
  state: string;
  entityId?: string;
  method?: string;
  confidence?: string;
  reviewItemId?: string;
  resolvedAt?: Iso;
  error?: string;
  resolverVersion?: string;
}

export interface Observation {
  _id: string;
  sourceId: string;
  snapshotId?: string;
  artifactId?: string;
  locator?: string;
  externalId?: string;
  contentHash: string;
  firstObservedAt: Iso;
  lastObservedAt: Iso;
  seenCount: number;
  parser: { name: string; version: string };
  ai?: { provider: string; model: string; promptVersion: string };
  warnings: string[];
  resolution: ObservationResolution;
  runId?: string;
  payload: JsonObject;
  createdAt: Iso;
}

export interface CompanyDetail {
  company: Company;
  survivor: Company | null;
  observations: Observation[];
  observationSources: SourceSummary[];
  jobs: Job[];
  jobSources: Source[];
  reviews: ReviewItem[];
  audit: AuditEvent[];
}

// ------------------------------------------------------------------ jobs

export type JobState =
  'DISCOVERED' | 'VERIFIED_LIVE' | 'CHANGED' | 'POSSIBLY_STALE' | 'CLOSED' | 'REOPENED' | 'REPOSTED';

export interface SourceRef {
  key: string;
  sourceId: string;
  externalId: string;
  provider: string;
  authority: AuthorityTier;
  postingUrl: string | null;
  applyUrl: string | null;
  requisitionId: string | null;
  firstSeenAt: Iso;
  lastSeenAt: Iso;
  present: boolean;
  lastObservationId: string;
  contentHash: string;
}

export interface EvidenceSpan {
  field: string;
  start?: number;
  end?: number;
  quote: string;
}

export interface RemoteScope {
  type: string;
  countries: string[];
  regions: string[];
  excludedCountries: string[];
  excludedRegions: string[];
  timezone: { minUtcOffset: number | null; maxUtcOffset: number | null; text: string } | null;
}

export interface OfficeAttendance {
  required: boolean | null;
  daysPerWeek: number | null;
  officeLocations: string[];
}

export interface Sponsorship {
  status: 'explicit_yes' | 'explicit_no' | 'company_capable' | 'historical_evidence' | 'unclear';
  roleStatement: 'yes' | 'no' | 'none';
  companyCapability: 'licensed' | 'historical' | 'none' | 'unknown';
  capabilityCountries: string[];
}

export interface Authorization {
  required: boolean | null;
  countries: string[];
  qualifiers: string[];
}

export interface Compensation {
  status: 'parsed' | 'unknown' | 'ambiguous' | 'malformed';
  min: number | null;
  max: number | null;
  currency: string | null;
  period: string | null;
  basis: string;
  annualized: { min: number | null; max: number | null; assumptions: string[] } | null;
  equityText: string | null;
  bonusText: string | null;
  originalText: string | null;
  warnings: string[];
}

export interface Requirement {
  text: string;
  normalizedConcept: string | null;
  category: string;
  importance: string;
  explicitness: string;
  yearsMin: number | null;
  section: string | null;
  evidence: EvidenceSpan;
  confidence: string;
}

export type Responsibilities = Record<string, { present: boolean; evidence: EvidenceSpan[] }>;

export interface NormalizedLocation {
  text: string;
  city: string | null;
  region: string | null;
  country: string | null;
  isRemoteLabel: boolean;
}

export interface Job {
  _id: string;
  companyId: string;
  status: 'active' | 'merged';
  mergedInto?: string;
  sourceRefs: SourceRef[];
  requisitionId: string | null;
  identity: {
    title: Fact<string>;
    normalizedTitle: string;
    roleFamily: Fact<string>;
    specialization: Fact<string>;
    department: Fact<string>;
    seniority: Fact<string>;
  };
  content: {
    primaryObservationId: string;
    descriptionArtifactId?: string;
    descriptionText?: string;
    descriptionHash: string;
  };
  employment: { employmentType: Fact<string> };
  geography: {
    listedLocations: string[];
    normalizedLocations: NormalizedLocation[];
    workModel: Fact<string>;
    remoteScope: Fact<RemoteScope>;
    officeAttendance: Fact<OfficeAttendance>;
  };
  immigration: {
    sponsorship: Fact<Sponsorship>;
    authorization: Fact<Authorization>;
    relocation: Fact<string>;
  };
  compensation: Fact<Compensation>;
  requirements: Fact<Requirement[]>;
  responsibilities: Fact<Responsibilities>;
  application: {
    canonicalPostingUrl: string | null;
    applyUrl: string | null;
    ats: { provider: string; boardToken: string | null } | null;
  };
  lifecycle: {
    state: JobState;
    firstSeenAt: Iso;
    lastSeenAt: Iso;
    lastVerifiedAt?: Iso;
    publishedAt?: Iso;
    lastChangedAt?: Iso;
    closedAt?: Iso;
    closeReason?: string;
    consecutiveAbsences: number;
    consecutiveNotFound: number;
    history: Array<{
      at: Iso;
      from: JobState | null;
      to: JobState;
      reason: string;
      sourceId?: string;
      evidence?: string;
    }>;
  };
  verification: {
    lastVerifiedAt?: Iso;
    lastOutcome?: 'live' | 'not_found' | 'inconclusive';
    nextVerificationDueAt?: Iso;
  };
  interpretation: {
    logicVersion: string;
    policyVersion: string;
    taxonomyVersion: string;
    computedAt: Iso;
    basedOnObservationId: string;
    flags: Array<{ code: string; message: string; severity: 'info' | 'warning' | 'high' }>;
  };
  aiProposals?: Array<{
    task: string;
    meta: Record<string, unknown>;
    data: unknown;
    createdAt: Iso;
    applied: boolean;
  }>;
  overrides?: Record<string, { value: unknown; reason: string; actorId: string; at: Iso }>;
  duplicateOf?: string[];
  distinctFrom?: string[];
  reposts?: Array<{ at: Iso; sourceKey: string; previousState: JobState }>;
  quality: { conflictFields: string[]; openReviewCount: number; sourceCount: number };
  createdAt: Iso;
  updatedAt: Iso;
}

export interface JobVerification {
  _id: string;
  jobId: string;
  sourceId?: string;
  method: string;
  url?: string;
  httpStatus?: number;
  outcome: 'live' | 'not_found' | 'inconclusive';
  detail: string;
  artifactId?: string;
  runId?: string;
  stateBefore: string;
  stateAfter: string;
  at: Iso;
}

export interface JobDetail {
  job: Job;
  company: { _id: string; name: string | null; sponsorship: CompanySponsorship; domain: string | null };
  observations: Observation[];
  sources: SourceSummary[];
  verifications: JobVerification[];
  reviews: ReviewItem[];
  audit: AuditEvent[];
}

// ------------------------------------------------------------------ review

export type ReviewAction =
  'confirm' | 'correct' | 'merge' | 'create_new' | 'keep_separate' | 'reject' | 'retry' | 'dismiss';

export interface ReviewCandidate {
  kind: 'company' | 'job';
  id: string;
  label: string;
  score?: number;
  details?: JsonObject;
}

export interface ReviewItem {
  _id: string;
  type: string;
  severity: 'low' | 'medium' | 'high';
  priority: number;
  status: 'open' | 'resolved' | 'dismissed';
  dedupeKey: string;
  entity: { kind: 'company' | 'job' | 'observation' | 'source'; id: string };
  subject: string;
  reason: string;
  evidence: Evidence[];
  candidates: ReviewCandidate[];
  observationIds: string[];
  context: JsonObject;
  allowedActions: ReviewAction[];
  occurrences: number;
  resolution?: {
    action: ReviewAction;
    reason: string;
    value?: Json;
    targetId?: string;
    actor: { kind: string; id: string };
    at: Iso;
    result?: JsonObject;
  };
  createdAt: Iso;
  updatedAt: Iso;
}

/** Candidate entities are projected by the API (identity/geography/... only). */
export type PartialCompany = Partial<Company> & { _id: string };
export type PartialJob = Partial<Job> & { _id: string };

export interface ReviewDetail {
  item: ReviewItem;
  entity: (PartialCompany | PartialJob | Source) | null;
  observations: Observation[];
  candidates: Array<ReviewCandidate & { entity: PartialCompany | PartialJob | null }>;
  audit: AuditEvent[];
}

export interface ObservationDetail {
  observation: Observation | null;
  kind?: 'company' | 'job';
  source?: SourceSummary | null;
}

// ------------------------------------------------------------------ dashboard

export interface QueueCounts {
  queue: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  paused: number;
  oldestWaitingAgeMs: number | null;
}

export interface RunStats {
  since: Iso;
  runsByState: Record<string, number>;
  activeRuns: number;
  nodeFailuresByCapability: Record<string, number>;
  waitingNodes: number;
  retryScheduledNodes: number;
  oldestQueuedAgeMs: number | null;
  meanAttemptsPerNode: number | null;
}

export interface Dashboard {
  window: { since: Iso; ms: number };
  sources: {
    byHealth: Record<string, number>;
    failing: Array<Pick<Source, '_id' | 'key' | 'name' | 'health'>>;
  };
  companies: { total: number; created: number; changed: number };
  jobs: { byState: Record<string, number>; created: number; changed: number; closed: number };
  review: { openByType: Record<string, number>; open: number; oldestOpenAgeMs: number | null };
  runs: RunStats;
  queues: QueueCounts[];
  freshness: {
    overdueSources: Array<{
      sourceId: string;
      key: string;
      name: string;
      ageMs: number | null;
      maxAgeMs: number;
      status: string;
    }>;
    jobsDueForVerification: number;
  };
}

export interface DataQuality {
  window: { since: Iso; ms: number };
  entityQuality: {
    companyObservationResolution: Record<string, number>;
    unresolvedCompanyRate: number | null;
    jobObservationResolution: Record<string, number>;
    duplicateReviews: Record<string, number>;
    mergedCompanies: number;
    duplicateCompanyRate: number | null;
    observationToCanonicalLagMs: number | null;
  };
  jobQuality: {
    verifiedLiveRate: number | null;
    staleRate: number | null;
    verificationsByOutcome: Record<string, number>;
  };
  intelligence: {
    workModel: Record<string, number>;
    remoteScope: Record<string, number>;
    sponsorship: Record<string, number>;
    salaryStatus: Record<string, number>;
    workModelConfidence: Record<string, number>;
  };
  review: { decisionsByAction: Record<string, number>; correctionRate: number | null };
}

export interface Readiness {
  status: 'ready' | 'not_ready';
  checks: Record<string, boolean>;
}

// ------------------------------------------------------------------ list v2 (M7.2–M7.4)

/** List v2 page (`market-provenance.md` § List v2): `total` is null with `count=none`. */
export interface ListPage<T> {
  items: T[];
  total: number | null;
  limit: number;
  offset: number;
  nextCursor: string | null;
}

/** `GET /api/jobs?view=summary` row (`market-jobs.md`). */
export interface JobSummary {
  _id: string;
  companyId: string;
  companyName: string | null;
  status: 'active' | 'merged';
  mergedInto?: string;
  identity: { title: SummaryFact<string>; seniority: SummaryFact<string> };
  employment: { employmentType: SummaryFact<string> };
  geography: {
    listedLocations: string[];
    locationCount: number;
    countries: string[];
    workModel: SummaryFact<string>;
    remoteScope: SummaryFact<RemoteScope>;
  };
  immigration: {
    sponsorship: SummaryFact<Sponsorship>;
    authorization: SummaryFact<Authorization>;
    relocation: SummaryFact<string>;
  };
  compensation: SummaryFact<{
    status: string;
    min: number | null;
    max: number | null;
    currency: string | null;
    period: string | null;
    basis: string;
    annualized: { min: number | null; max: number | null } | null;
    warnings: string[];
    originalText: string | null;
  }>;
  postingUrl: string | null;
  lifecycle: {
    state: JobState;
    firstSeenAt: Iso;
    lastSeenAt: Iso;
    publishedAt?: Iso;
    lastChangedAt?: Iso;
    closedAt?: Iso;
    closeReason?: string;
  };
  verification: { lastVerifiedAt?: Iso; lastOutcome?: string; nextVerificationDueAt?: Iso };
  flags: Array<{ code: string; severity: 'info' | 'warning' | 'high' }>;
  quality: { conflictFields: string[]; sourceCount: number };
  openReviewCount: number;
  providers: string[];
  rev: number;
  contentHash: string;
  updatedAt: Iso;
}

/** `GET /api/companies?view=summary` row (`market-companies.md`). */
export interface CompanySummary {
  _id: string;
  status: 'active' | 'merged';
  mergedInto?: string;
  identity: {
    displayName: SummaryFact<string>;
    legalName: SummaryFact<string>;
    normalizedName: string;
    domain: SummaryFact<string>;
    website: SummaryFact<string>;
    aliases: string[];
  };
  geography: { headquarters: SummaryFact<Location> };
  employment: {
    careersUrls: SummaryFact<string[]>;
    ats: SummaryFact<Array<{ provider: string; boardToken: string }>>;
    sponsorship: { capability: SummaryFact<'licensed' | 'previously_licensed'>; licenceCountries: string[] };
  };
  quality: { observationCount: number; sourceCount: number; conflictFields: string[] };
  freshness: {
    careersDiscoveryStatus: string;
    careersCheckedAt?: Iso;
    lastChangedAt?: Iso;
    lastReconciledAt?: Iso;
  };
  activeJobCount: number;
  openReviewCount: number;
  rev: number;
  contentHash: string | null;
  createdAt: Iso;
  updatedAt: Iso;
}

/** `GET /api/sources` v2 row: the source plus server-computed freshness (`market-sources.md`). */
export interface SourceListItem extends Source {
  freshnessState: 'fresh' | 'due' | 'overdue' | 'never_succeeded' | 'disabled';
  freshnessAgeMs: number | null;
  companyName: string | null;
}

/** `GET /api/review` v2 row (`market-review.md`): the item plus server-computed state. */
export interface ReviewListItem extends ReviewItem {
  queueState: 'open' | 'resolving' | 'failed' | 'resolved' | 'dismissed';
  /** A resolution in progress (ADR-0017), not a triage claim. */
  claim?: {
    operationId: string;
    actor: { kind: string; id: string };
    action: ReviewAction;
    reason: string;
    targetId?: string;
  };
  lastFailure?: {
    operationId: string;
    action: ReviewAction;
    kind: string;
    code: string;
    message: string;
    at: Iso;
  };
  targetFields?: string[];
}

// ---------------------------------------------------------------- imports (market-imports.md)

export type ImportType = 'companies' | 'ats_boards' | 'snapshot' | 'jobs';
export type ImportStatus = 'processing' | 'completed' | 'completed_with_issues' | 'failed' | 'cancelled';

/** `null` = not known yet (still processing) or not meaningful for the type. */
export interface ImportCounts {
  rows: number | null;
  parsed: number | null;
  accepted: number | null;
  created: number | null;
  updated: number | null;
  unchanged: number | null;
  ignored: number | null;
  failed: number | null;
  reviews: number | null;
  /** Rows imported with a warning. Newer API builds only. */
  warnings?: number | null;
}

/** `GET /api/imports` row: the detail without `trace`. Status and counts are derived by the API. */
export interface ImportSummary {
  _id: string;
  type: ImportType;
  fileName: string;
  contentType: string;
  bytes: number;
  contentHash: string;
  artifactId: string;
  snapshotId: string;
  snapshotUnchanged: boolean;
  sourceId: string;
  runId: string | null;
  createdBy: { kind: string; id: string };
  createdAt: Iso;
  error?: { code: string; message: string };
  source: { id: string; name: string; provider: string };
  status: ImportStatus;
  startedAt: Iso | null;
  finishedAt: Iso | null;
  counts: ImportCounts;
}

/** `GET /api/imports/:id` (and the `201` of `POST /api/imports`). Trace lists hold at most 200 ids. */
export interface ImportDetail extends ImportSummary {
  trace: {
    runId: string | null;
    snapshotId: string;
    artifactId: string;
    reviewIds: string[];
    companyIds: string[];
    sourceIds: string[];
    truncated: boolean;
    /** Row warnings and errors as a file. Newer API builds only. */
    reportArtifactId?: string | null;
  };
}
