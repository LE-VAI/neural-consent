/**
 * Type definitions for neural-consent.
 *
 * Hand-written. The value here is in the SHAPES a host must handle correctly:
 * the consent lifecycle states, the distinction between a declaration and a
 * silence, and the fact that a decision is recorded rather than merely stored.
 * Anything not listed is internal.
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
  /**
   * Present and true only on the opt-in purpose. A UI must render such a
   * purpose separately (its own control, off by default) — never inside a
   * group with a shared "agree" action.
   */
  requiresExplicitGrant?: boolean;
}

export declare const PURPOSES: {
  readonly ACQUIRE_SIGNAL: Purpose;
  readonly PROCESS_LOCALLY: Purpose;
  readonly PERSIST_LOCALLY: Purpose;
  readonly EXPORT: Purpose;
  /**
   * Off by default, excluded from DEFAULT_PURPOSES, and un-bundlable with any
   * other purpose. For tools that read the signal locally but offer an
   * optional online feature; covers the derived summary those features send,
   * never the raw signal.
   */
  readonly SHARE_DERIVED_METADATA: Purpose;
};

/** The four purposes a local-first tool actually has. */
export declare const CORE_PURPOSES: readonly Purpose[];
/**
 * What a tool presents when it has no online path — the common case, and the
 * default. Use this, not ALL_PURPOSES, unless the tool really has an online
 * feature to disclose.
 */
export declare const DEFAULT_PURPOSES: readonly Purpose[];
/** Every purpose this module knows, including the opt-in one. */
export declare const ALL_PURPOSES: readonly Purpose[];

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
 *
 * It also claims nothing about the HOST tool: the text renders in the host's
 * UI, so any statement about the host's behaviour would be this library
 * asserting something it cannot observe. Render `ConsentManager.disclaimerText()`
 * instead of `DISCLAIMER.full` — the former appends the host's own declaration.
 */
export declare const DISCLAIMER: Disclaimer;

/**
 * How a tool says it handles the signal. A closed vocabulary: an unlisted
 * value is refused rather than passed through.
 */
export declare const SIGNAL_HANDLING: {
  readonly LOCAL_ONLY: 'local-only';
  readonly TRANSMITTED: 'transmitted';
};

export declare const DERIVED_METADATA_HANDLING: {
  readonly NONE: 'none';
  readonly SHARED: 'shared';
};

/**
 * What the embedding tool declares about ITSELF.
 *
 * Supply this or the record reports the handling as unstated — which is the
 * honest default for a library that cannot observe its host. An incoherent
 * declaration (says it shares derived data but names no recipient, or names
 * recipients while claiming nothing is shared) returns null from
 * normalizeDeclaration and throws from setDeclaration.
 */
export interface Declaration {
  signal: 'local-only' | 'transmitted';
  derivedMetadata: 'none' | 'shared';
  /** Required when derivedMetadata is 'shared', and refused when it is 'none'. */
  recipients?: string[];
  declaredBy?: string;
  declaredAt?: string;
  declarationVersion?: string;
}

export interface NormalizedDeclaration {
  readonly signal: 'local-only' | 'transmitted';
  readonly derivedMetadata: 'none' | 'shared';
  readonly recipients: readonly string[];
  readonly declaredBy: string | null;
  readonly declaredAt: string;
  readonly declarationVersion: string;
}

export declare function normalizeDeclaration(
  declaration: Declaration | null | undefined,
  now?: () => number
): NormalizedDeclaration | null;

/**
 * Render a declaration as text a person can read. With no declaration this
 * returns a statement of ABSENCE in the same weight a declaration would
 * occupy — an omitted section reads as reassurance the tool never gave.
 */
export declare function declarationText(declaration?: NormalizedDeclaration | null): string;

/** The full disclaimer with the host's declaration attached — what a UI shows. */
export declare function disclaimerText(declaration?: NormalizedDeclaration | null): string;

export declare function noticeVersion(purposes?: readonly Purpose[]): string;
export declare function purposeById(id: string): Purpose | null;
/**
 * Resolve ids (or definitions) to definitions, THROWING on an unknown id. A
 * tool asking for a purpose this module lacks has a bug, and silently
 * presenting one fewer permission would hide it.
 */
export declare function resolvePurposes(ids: Array<string | Purpose>): Purpose[];
export declare function keyInformationText(purposes?: readonly Purpose[]): string;

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
  storage: 'local-only' | 'transmitted';
  /**
   * False means the tool declared nothing — distinct from `stated: true,
   * recipients: []`, which is a tool that declared it transmits nothing. A
   * reader must be able to tell a declaration from a silence.
   */
  stated: boolean;
  recipients: string[];
  recipientsDeclaration: string;
  signal: string | null;
  derivedMetadata: string | null;
  declaredBy: string | null;
  declaredAt: string | null;
  /** 27560 fields deliberately not carried, recorded rather than silently omitted. */
  omittedFields: string[];
}

export interface RecordJSON {
  schemaVersion: string;
  recordId: string;
  subjectId: string;
  createdAt: string;
  purposes: Record<string, PurposeEntry>;
  declaration: NormalizedDeclaration | null;
  handling: Handling;
  events: ConsentEvent[];
}

export interface VerifyResult {
  ok: boolean;
  /** Seq of the first event whose hash does not match, or -1. */
  brokenAt: number;
  /**
   * True when the log is internally sound but `purposes` does not match what
   * the last event recorded — the signature of a grant edited behind the log.
   */
  stateMismatch: boolean;
}

export interface ChainResult {
  ok: boolean;
  brokenAt: number;
}

export interface RecordSummary {
  recordId: string;
  createdAt: string;
  granted: string[];
  events: number;
  /** Does the LOG verify? False only when an event was altered or removed. */
  chainIntact: boolean;
  /** Does the live grant state match the log? Distinct from chainIntact. */
  stateMatchesChain: boolean;
  brokenAt: number;
  recipients: string;
  handlingStated: boolean;
}

/** What a host sends so a service can tell a cached grant is stale. Not a credential. */
export interface RevocationState {
  recordId: string;
  /** Count of withdrawals in the record's history. Derived from the log. */
  epoch: number;
  granted: string[];
  at: string;
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
    declaration?: NormalizedDeclaration | null;
  });

  schemaVersion: string;
  recordId: string;
  subjectId: string;
  createdAt: string;
  purposes: Record<string, PurposeEntry>;
  /**
   * Built from the host's declaration. With none, `stated` is false and the
   * record says the handling is UNSTATED rather than asserting "none".
   */
  handling: Handling;
  /** The host's declaration, or null if it made none. */
  declaration: NormalizedDeclaration | null;
  events: ConsentEvent[];

  /** The 27560 recipient fields re-derived from the current declaration. */
  readonly declaredHandling: Handling;
  /** Withdrawals recorded in this record's history. Derived from the log. */
  readonly consentEpoch: number;

  decide(purposeId: string, state: ConsentState, meta?: DecideMeta): ConsentEvent;
  withdraw(purposeId: string, meta?: { reason?: string }): ConsentEvent | null;
  reaffirm(purposeId: string, meta?: DecideMeta): ConsentEvent;
  /** Mark lapsed grants expired. Returns the ids that expired, so a host can re-ask. */
  expireLapsed(): string[];
  isGranted(purposeId: string): boolean;
  grantedPurposes(): string[];
  revocationState(): RevocationState;
  append(type: string, payload?: Record<string, unknown>): ConsentEvent;
  /** The event chain AND the live state. See VerifyResult. */
  verify(): VerifyResult;
  /** The event chain alone. False only when an event was altered or removed. */
  verifyChain(): ChainResult;
  toJSON(): RecordJSON;
  /**
   * VERIFIES and fails CLOSED: a tampered record restores with an empty
   * purpose set and the reason on `integrityReason`. A declaration passed here
   * overrides the one in the file — a stale "nothing transmitted" must not be
   * restored over a tool that has since added an online path.
   */
  static fromJSON(
    data: RecordJSON,
    options?: { now?: () => number; declaration?: NormalizedDeclaration | null }
  ): ConsentRecord;
  summary(): RecordSummary;

  integrity: VerifyResult;
  integrityReason: string | null;
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
  /** Key for the hash-only erasure tombstone. Defaults to `${storageKey}.erased`. */
  erasureKey?: string;
  recordId?: string;
  now?: () => number;
  /** Validity window for a grant. Consent should lapse. */
  validDays?: number;
  language?: string;
  /** What THIS TOOL does with signal and derived data. Omit and the record says unstated. */
  declaration?: Declaration | null;
  /** Ids the tool presents. Defaults to DEFAULT_PURPOSES; add 'share_derived_metadata' explicitly. */
  purposes?: Array<string | Purpose>;
  /** Keep a hash-only tombstone on erase() so a withdrawal is not erased out of existence. Default true. */
  retainErasureLog?: boolean;
}

export interface PurposeSnapshot {
  id: string;
  label: string;
  keyText: string;
  detailText: string;
  version: string;
  requiresExplicitGrant: boolean;
  state: ConsentState | null;
  entry: PurposeEntry | null;
}

export interface Snapshot {
  recordId: string;
  createdAt: string;
  /** The gate's answer, so a UI does not re-derive it and get it wrong. */
  granted: string[];
  /**
   * Grants the gate honours for purposes this tool no longer presents.
   * Non-empty here means the user should be shown and offered a way to revoke
   * them — a live grant they cannot see is the worst leftover.
   */
  grantedButNotPresented: string[];
  purposes: PurposeSnapshot[];
  disclaimer: Disclaimer;
  /** The renderable disclaimer WITH the tool's declaration appended. Render this. */
  disclaimerText: string;
  declaration: NormalizedDeclaration | null;
  declarationText: string;
  handling: Handling;
  chain: VerifyResult;
  /** The log alone — distinct from `chain.ok`. */
  chainIntact: boolean;
  consentEpoch: number;
  eventCount: number;
  /** The erasure tombstone, if one exists. */
  erasure: ErasureTombstone | null;
}

/** Hash-only record that a consent record was erased. Carries no personal data. */
export interface ErasureTombstone {
  schemaVersion: string;
  recordId: string;
  erasedAt: string;
  withdrawalCount: number;
  eventCount: number;
  chainHead: string | null;
  reason: string;
  containsPersonalData: false;
  note: string;
}

export type ConsentEventType =
  | 'grant' | 'refuse' | 'withdraw' | 'withdraw-all'
  | 'reaffirm' | 'expired' | 'erase' | 'declare';

export declare class ConsentManager {
  constructor(options?: ManagerOptions);

  record: ConsentRecord;
  storageKey: string;
  erasureKey: string;
  validDays: number;
  language: string;
  declaration: NormalizedDeclaration | null;
  /** The purposes this tool presents. */
  purposes: Purpose[];
  retainErasureLog: boolean;

  isGranted(purposeId: string): boolean;
  /**
   * THROW unless consent is held. Throwing rather than returning falsy is
   * deliberate: a silently-skipped permission check is how consent stops
   * gating.
   */
  require(purposeId: string): true;

  granted(): string[];
  /** True if this tool presents the given purpose at all. */
  presents(purposeId: string): boolean;

  /**
   * Grant consent. For an opt-in purpose (requiresExplicitGrant) this THROWS
   * unless meta.explicit is true — it must never be granted in a batch,
   * implied by another purpose, or set from a default.
   */
  grant(purposeId: string, meta?: DecideMeta & { explicit?: boolean }): ConsentEvent;
  refuse(purposeId: string, meta?: DecideMeta): ConsentEvent;
  withdraw(purposeId: string, meta?: { reason?: string }): ConsentEvent | null;
  /** Withdraws every live grant, including any not on the current screen. */
  withdrawAll(meta?: { reason?: string }): ConsentEvent[];
  /**
   * Reset the validity window on an existing grant (Colorado requires refresh).
   * Throws on an opt-in purpose without `{ explicit: true }`.
   */
  reaffirm(purposeId: string, meta?: DecideMeta & { explicit?: boolean }): ConsentEvent;

  /** Update what this tool declares. Recorded as an event; throws if incoherent. */
  setDeclaration(declaration: Declaration | null): NormalizedDeclaration | null;
  declarationText(): string;
  disclaimerText(): string;

  stateOf(purposeId: string): ConsentState | null;
  snapshot(): Snapshot;
  onChange(fn: (evt: { type: ConsentEventType; purposeId?: string; purposes?: string[] }, snap: Snapshot) => void): () => void;

  /** The portability path the user controls. */
  export(): string;
  /**
   * Erase everything locally, keeping a hash-only tombstone by default so the
   * withdrawal remains provable. Pass `{ keepTombstone: false }` for no trace
   * at all. Returns what was erased.
   */
  erase(meta?: { reason?: string; keepTombstone?: boolean }): {
    recordId: string;
    epochs: number;
    granted: string[];
    events: number;
    chainHash: string | null;
  };
  /** The erasure tombstone, if one exists. */
  erasureInfo(): ErasureTombstone | null;
}

export declare class ConsentRequiredError extends Error {
  name: 'ConsentRequiredError';
  purposeId: string;
  constructor(purposeId: string);
}
