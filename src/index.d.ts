/**
 * Type definitions for neural-consent.
 *
 * Hand-written. The value here is in the SHAPES a host must handle correctly:
 * the consent lifecycle states, and the fact that a decision is recorded rather
 * than merely stored. Anything not listed is internal.
 */

// ---------------------------------------------------------------------------
// Purposes and notices
// ---------------------------------------------------------------------------

export interface Purpose {
  id: string;
  /** Bumped when the TEXT changes, so a record can say what was actually shown. */
  version: string;
  label: string;
  /** The concise statement shown first (45 CFR 46.116(a)(5)(i)'s layered model). */
  keyText: string;
  /** The fuller explanation, available on request. */
  detailText: string;
}

export declare const PURPOSES: {
  readonly ACQUIRE_SIGNAL: Purpose;
  readonly PROCESS_LOCALLY: Purpose;
  readonly EXPORT: Purpose;
  readonly PERSIST_LOCALLY: Purpose;
};

export interface Disclaimer {
  version: string;
  short: string;
  full: string;
}

/**
 * States the tool must NOT claim. A test asserts the text never contains them,
 * and a CI job makes that assertion unmissable — the failure mode is silent,
 * because a well-meaning edit adding "ISO 27560 compliant" would look like an
 * improvement and would be false.
 */
export declare const DISCLAIMER: Disclaimer;

export declare function noticeVersion(purposes?: Purpose[]): string;
export declare function purposeById(id: string): Purpose | null;
export declare function keyInformationText(purposes?: Purpose[]): string;

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

export declare const SCHEMA_VERSION: string;

/** ISO/IEC TS 27560 consent lifecycle states. */
export type ConsentState = 'requested' | 'given' | 'refused' | 'withdrawn' | 'expired' | 'terminated';

export interface ConsentEvent {
  seq: number;
  type: string;
  at: string;
  purposeId?: string;
  state?: ConsentState;
  /** FNV-1a of the previous event — the chain makes edits detectable. */
  prevHash: string;
  hash: string;
  [key: string]: unknown;
}

export interface PurposeEntry {
  purposeId: string;
  state: ConsentState;
  noticeId: string;
  /** What the person actually agreed to — an evidentiary question. */
  noticeVersion: string;
  language: string;
  dataTypes: string[];
  sensitivity: 'neural';
  grantedAt: string | null;
  validUntil: string | null;
  /** 27560 requires a named path. It must describe a route that exists. */
  withdrawalMethod: string;
  legalBasis: string;
  withdrawnAt?: string;
  expiredAt?: string;
}

export interface Handling {
  storage: string;
  recipients: unknown[];
  recipientsDeclaration: string;
  /** 27560 fields deliberately not carried, recorded rather than silently omitted. */
  omittedFields: string[];
}

export interface RecordJSON {
  schemaVersion: string;
  recordId: string;
  subjectId: string;
  createdAt: string;
  purposes: Record<string, PurposeEntry>;
  handling: Handling;
  events: ConsentEvent[];
}

export interface RecordSummary {
  recordId: string;
  createdAt: string;
  granted: string[];
  events: number;
  /** False means the log was modified — the check is tamper-EVIDENT, not tamper-proof. */
  chainIntact: boolean;
  recipients: string;
}

export interface VerifyResult {
  ok: boolean;
  /** Seq of the first event whose hash does not match, or -1. */
  brokenAt: number;
}

export interface DecideMeta {
  noticeId?: string;
  noticeVersion?: string;
  language?: string;
  validDays?: number;
  dataTypes?: string[];
  withdrawalMethod?: string;
  legalBasis?: string;
}

export declare class ConsentRecord {
  constructor(options?: {
    subjectId?: string;
    recordId?: string;
    createdAt?: string;
    now?: () => number;
    storageKey?: string;
  });

  schemaVersion: string;
  recordId: string;
  subjectId: string;
  createdAt: string;
  purposes: Record<string, PurposeEntry>;
  /** `recipients` is always empty, and that is the point — the machine-readable claim. */
  handling: Handling;
  events: ConsentEvent[];

  decide(purposeId: string, state: ConsentState, meta?: DecideMeta): ConsentEvent;
  withdraw(purposeId: string, meta?: { reason?: string }): ConsentEvent | null;
  reaffirm(purposeId: string, meta?: DecideMeta): ConsentEvent;
  /** Mark lapsed grants expired. Returns the ids that expired, so a host can re-ask. */
  expireLapsed(): string[];
  isGranted(purposeId: string): boolean;
  grantedPurposes(): string[];
  append(type: string, payload?: Record<string, unknown>): ConsentEvent;
  verify(): VerifyResult;
  toJSON(): RecordJSON;
  static fromJSON(data: RecordJSON, options?: { now?: () => number }): ConsentRecord;
  summary(): RecordSummary;
}

export declare function generateId(): string;
/** Deterministic 32-bit hash for the event chain. Not a security hash. */
export declare function fnv1a(str: string): string;

// ---------------------------------------------------------------------------
// Manager — the surface a tool actually talks to
// ---------------------------------------------------------------------------

export interface ManagerOptions {
  /** An object with getItem/setItem/removeItem (e.g. window.localStorage). Omit for in-memory. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  storageKey?: string;
  recordId?: string;
  now?: () => number;
  /** Validity window for a grant. Consent should lapse. */
  validDays?: number;
  language?: string;
}

export interface PurposeSnapshot {
  id: string;
  label: string;
  keyText: string;
  detailText: string;
  version: string;
  state: ConsentState | null;
  entry: PurposeEntry | null;
}

export interface Snapshot {
  recordId: string;
  createdAt: string;
  /** The gate's answer, so a UI does not re-derive it and get it wrong. */
  granted: string[];
  purposes: PurposeSnapshot[];
  disclaimer: Disclaimer;
  handling: Handling;
  chain: VerifyResult;
  eventCount: number;
}

export type ConsentEventType = 'grant' | 'refuse' | 'withdraw' | 'withdraw-all' | 'reaffirm' | 'expired' | 'erase';

export declare class ConsentManager {
  constructor(options?: ManagerOptions);

  record: ConsentRecord;
  storageKey: string;
  validDays: number;
  language: string;

  isGranted(purposeId: string): boolean;
  /**
   * THROW unless consent is held. Throwing rather than returning falsy is
   * deliberate: a silently-skipped permission check is how consent stops
   * gating.
   */
  require(purposeId: string): true;

  granted(): string[];
  grant(purposeId: string, meta?: DecideMeta): ConsentEvent;
  refuse(purposeId: string, meta?: DecideMeta): ConsentEvent;
  withdraw(purposeId: string, meta?: { reason?: string }): ConsentEvent | null;
  withdrawAll(meta?: { reason?: string }): ConsentEvent[];
  /** Reset the validity window on an existing grant (Colorado requires refresh). */
  reaffirm(purposeId: string, meta?: DecideMeta): ConsentEvent;

  stateOf(purposeId: string): ConsentState | null;
  snapshot(): Snapshot;
  onChange(fn: (evt: { type: ConsentEventType; purposeId?: string; purposes?: string[] }, snap: Snapshot) => void): () => void;

  /** The portability path the user controls. */
  export(): string;
  erase(): void;
}

export declare class ConsentRequiredError extends Error {
  name: 'ConsentRequiredError';
  purposeId: string;
  constructor(purposeId: string);
}
