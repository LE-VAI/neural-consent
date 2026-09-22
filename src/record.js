/**
 * record.js — the consent record and its event log.
 *
 * DATA MODEL BASIS. The field set follows ISO/IEC TS 27560:2023 ("Privacy
 * technologies — Consent record information structure"), whose mandatory
 * fields are public via the W3C Data Privacy Vocabularies and Controls CG
 * guide (published 2026-02-15). Two deliberate departures, each documented
 * where it happens, because blindly copying an inter-organisational standard
 * into a local-first tool imports fields that exist only to make records
 * exchangeable BETWEEN organisations.
 *
 * WHAT 27560 ASKS FOR AND WHY WE KEEP IT:
 *   - schema version, record id, subject id  → the record must be
 *     self-describing and attributable
 *   - privacy notice + language               → "what did they actually agree
 *     to" is an evidentiary question
 *   - purpose, data types, retention          → purpose limitation
 *   - withdrawal method                       → must name a REAL working path
 *   - events: time, validity, entity, type, state
 *
 * WHAT WE DROP, AND WHY: 27560 mandates a controller address, jurisdiction,
 * and an authority party — fields whose only function is to let one
 * organisation's records be read by another. A local-first tool exchanges
 * nothing with anyone, so carrying a controller address would be theatre.
 * The fields are documented as intentionally absent rather than silently
 * omitted, so a reviewer can see the decision.
 *
 * THE EVENT LOG IS TAMPER-EVIDENT, NOT TAMPER-PROOF. Each event carries the
 * hash of the previous one, so altering or removing a past entry breaks the
 * chain and verify() reports it. A determined user with their own device can
 * always rewrite the whole file — that is inherent to local-first storage and
 * pretending otherwise would be a lie. The chain's job is to make ACCIDENTAL
 * or partial modification detectable, and to give the user a way to check
 * their own record was not quietly changed by the tool.
 */

/** Bump when the record shape changes; recorded in every record. */
export const SCHEMA_VERSION = '1.1.0';

/**
 * Consent lifecycle states (ISO/IEC TS 27560 event states).
 *   requested  — the user was asked
 *   given      — the user agreed
 *   refused    — the user declined
 *   withdrawn  — the user revoked a previous grant
 *   expired    — the validity window lapsed
 *   terminated — the tool or purpose no longer exists
 */
export const STATES = ['requested', 'given', 'refused', 'withdrawn', 'expired', 'terminated'];

/** The statuses a purpose can currently be in. */
export const ACTIVE_STATES = new Set(['given']);

/**
 * FNV-1a, 32-bit, as a hex string.
 *
 * Why not SHA-256: this runs in a browser with no dependencies, and the
 * WebCrypto digest is async — which would make every append() asynchronous
 * and force the whole API to be promise-based for a check that is only
 * detecting accidental modification. 32 bits is the right size for that job.
 * It is NOT a security hash and the code says so rather than implying it.
 */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Stable stringify so a hash does not depend on key order. */
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

/** Event hash = fnv1a(previous hash + canonical event payload). */
function eventHash(prevHash, event) {
  const { hash, ...rest } = event; // never hash the hash field itself
  return fnv1a(prevHash + '|' + canonical(rest));
}

/**
 * The 27560 recipient fields, built from the host's declaration.
 *
 * `stated: false` is what appears when the host declared nothing. It is
 * deliberately not the same shape as "declared nothing is transmitted" —
 * `stated: true, recipients: []` — because a reader (or a downstream system
 * ingesting the export) must be able to tell a declaration from a silence.
 * Conflating them would recreate the bug this function exists to fix, one
 * layer up: a machine-readable "no transmission" that nobody actually said.
 */
function handlingFrom(declaration) {
  const omittedFields = ['pii_controller_address', 'jurisdiction', 'authority_party'];
  if (!declaration) {
    return {
      storage: 'local-only',
      stated: false,
      recipients: [],
      recipientsDeclaration: 'unstated \u2014 the tool has not declared its handling',
      signal: null,
      derivedMetadata: null,
      declaredBy: null,
      declaredAt: null,
      // 27560 fields intentionally not carried (see the file header):
      omittedFields,
    };
  }
  return {
    storage: declaration.signal === 'local-only' ? 'local-only' : 'transmitted',
    stated: true,
    recipients: [...(declaration.recipients ?? [])],
    recipientsDeclaration: declaration.derivedMetadata === 'shared'
      ? `declared shared with: ${(declaration.recipients ?? []).join(', ')}`
      : 'declared none \u2014 no derived metadata transmitted',
    signal: declaration.signal,
    derivedMetadata: declaration.derivedMetadata,
    declaredBy: declaration.declaredBy ?? null,
    declaredAt: declaration.declaredAt ?? null,
    omittedFields,
  };
}

/**
 * A hash of the consent STATE — the projection of `purposes` that the gate
 * actually reads. Folded into every event so the chain witnesses authorization,
 * not merely activity (see append()).
 *
 * Only the fields that decide access are included: a record whose wording or
 * timestamps differ is not a tampered grant, and hashing everything would make
 * the check fire on innocuous edits until it became ignored.
 */
function stateHashOf(purposes) {
  const projection = Object.keys(purposes)
    .sort()
    .map((id) => [id, purposes[id]?.state ?? null, purposes[id]?.validUntil ?? null]);
  return fnv1a(canonical(projection));
}

/**
 * A local consent record.
 *
 * @param {object} [options]
 * @param {string} [options.subjectId] local pseudonymous id; never transmitted
 * @param {Function} [options.now] clock, injected for determinism
 * @param {string} [options.storageKey] localStorage key, when persistence is on
 */
export class ConsentRecord {
  constructor(options = {}) {
    // The clock must be assigned BEFORE anything reads it — createdAt below
    // depends on it, and reading it first was a real bug caught by the suite.
    this._now = options.now ?? (() => Date.now());
    this.schemaVersion = SCHEMA_VERSION;
    /** Set by fromJSON when a restored record failed verification. */
    this.integrity = { ok: true, brokenAt: -1, stateMismatch: false };
    this.integrityReason = null;
    this.recordId = options.recordId ?? generateId();
    this.subjectId = options.subjectId ?? generateId();
    this.createdAt = options.createdAt ?? new Date(this._now()).toISOString();
    this._storageKey = options.storageKey ?? null;

    /**
     * Per-purpose consent entries. Keyed by purpose id.
     * Each entry is the 27560 "Processing" block for one purpose.
     */
    this.purposes = {};

    /** Append-only event log. */
    this.events = [];

    /**
     * RECIPIENTS COME FROM THE HOST, NEVER FROM THIS LIBRARY.
     *
     * 27560 makes "recipient third parties" a mandatory field. An earlier
     * version of this file filled it with a constant — `recipients: []` and
     * `recipientsDeclaration: 'none — no transmission'` — on the reasoning that
     * this library has no server so there is nobody to receive the data.
     *
     * That reasoning is sound about the library and wrong about the record.
     * The record describes the TOOL, and the tool is the host's code. A host
     * that later adds one optional online feature would have shipped a machine-
     * readable declaration, in its own consent record, saying nothing is
     * transmitted — produced by this library, on the host's behalf, without
     * the host ever saying so. Same failure as the disclaimer; same fix.
     *
     * So `handling` is now derived from a declaration the host supplies. With
     * no declaration, the record says the handling is UNSTATED. That is a
     * weaker claim than "none" and it is the true one.
     */
    this.declaration = options.declaration ?? null;
    this.handling = handlingFrom(this.declaration);
  }

  /**
   * A machine-readable statement of what the tool does with signal and derived
   * data, for the record's 27560 recipient fields.
   *
   * `stated: false` is the honest default and is what makes this function worth
   * having: a reader of the exported record can distinguish "the tool declared
   * it transmits nothing" from "nobody recorded an answer."
   */
  get declaredHandling() { return handlingFrom(this.declaration); }

  /** Local pseudonymous identifier generator (no PII, no network). */
  _newEventId() {
    return generateId();
  }

  /**
   * Record a consent decision for one purpose.
   *
   * @param {string} purposeId
   * @param {('given'|'refused')} state
   * @param {object} [meta]
   * @param {string} meta.noticeVersion  the notice text version shown
   * @param {string} [meta.language]     BCP-47 tag of the text shown
   * @param {number} [meta.validDays]    validity window; consent should lapse
   * @param {string[]} [meta.dataTypes]  what data this purpose covers
   * @param {string} [meta.withdrawalMethod] how to revoke (must be real)
   * @returns {object} the event appended
   */
  decide(purposeId, state, meta = {}) {
    if (!STATES.includes(state)) {
      throw new Error(`unknown consent state: ${state}`);
    }
    const at = new Date(this._now()).toISOString();

    const entry = {
      purposeId,
      state,
      noticeId: meta.noticeId ?? 'default',
      noticeVersion: meta.noticeVersion ?? 'unversioned',
      language: meta.language ?? 'en',
      dataTypes: meta.dataTypes ?? [],
      sensitivity: 'neural',
      grantedAt: state === 'given' ? at : null,
      validUntil: this._validUntil(at, meta.validDays),
      // 27560 requires the withdrawal method be named. It must describe a
      // path that actually exists in the UI — naming a method the user
      // cannot reach is worse than omitting the field.
      withdrawalMethod: meta.withdrawalMethod ?? 'Settings \u2192 Consent \u2192 withdraw',
      // Legal basis is what the PUBLISHER asserts. This module does not
      // assert compliance on anyone's behalf, so it records the honest
      // default rather than inventing one.
      legalBasis: meta.legalBasis ?? 'consent',
    };

    this.purposes[purposeId] = entry;
    return this.append(state === 'given' ? 'grant' : 'refuse', {
      purposeId,
      state,
      ...entry,
    });
  }

  /** Withdraw a previously granted purpose. Symmetric and immediate. */
  withdraw(purposeId, meta = {}) {
    const existing = this.purposes[purposeId];
    if (!existing) throw new Error(`no consent recorded for purpose: ${purposeId}`);
    if (existing.state === 'withdrawn') return null; // idempotent
    const at = new Date(this._now()).toISOString();
    this.purposes[purposeId] = {
      ...existing,
      state: 'withdrawn',
      withdrawnAt: at,
    };
    return this.append('withdraw', {
      purposeId,
      state: 'withdrawn',
      at,
      reason: meta.reason ?? 'user request',
    });
  }

  /** Re-affirm consent (Colorado requires periodic refresh). */
  reaffirm(purposeId, meta = {}) {
    const existing = this.purposes[purposeId];
    if (!existing) throw new Error(`no consent recorded for purpose: ${purposeId}`);
    return this.decide(purposeId, 'given', { ...meta, noticeVersion: existing.noticeVersion });
  }

  /**
   * Mark any purpose whose validity window has lapsed as expired.
   * Returns the ids that expired, so the host can re-ask.
   */
  expireLapsed() {
    const now = this._now();
    const expired = [];
    for (const [id, entry] of Object.entries(this.purposes)) {
      if (entry.state !== 'given' || !entry.validUntil) continue;
      if (Date.parse(entry.validUntil) <= now) {
        this.purposes[id] = { ...entry, state: 'expired', expiredAt: new Date(now).toISOString() };
        this.append('expire', { purposeId: id, state: 'expired', at: new Date(now).toISOString() });
        expired.push(id);
      }
    }
    return expired;
  }

  /** Is consent currently held for this purpose? */
  isGranted(purposeId) {
    return this.purposes[purposeId]?.state === 'given';
  }

  /**
   * How many times consent has been withdrawn in this record's history.
   *
   * DERIVED, NOT STORED. A counter field would be one more thing that can fall
   * out of step with the event log — and this is the worst possible field to
   * have drift, because it is the one a remote service is asked to trust. It
   * counts the log, and the log is already hash-chained.
   */
  get consentEpoch() {
    return this.events.filter((e) => e.type === 'withdraw').length;
  }

  /**
   * The state a host may include when it makes an outbound request on the
   * user's behalf, so a service holding a cached grant can tell it has been
   * revoked.
   *
   * WHY THIS EXISTS. Withdrawal in a local-first tool has no reach: the record
   * lives in the user's browser, and a service that received derived metadata
   * last week has no way to learn that consent was revoked yesterday. Silence
   * is indistinguishable from "still granted", which means a revocation the
   * user made can be quietly ignored by every service they already talked to.
   * That is the gap. This library cannot close it — honoring a revocation is
   * the service's job and no client-side code can compel it — but it can make
   * closing it possible, by putting the epoch in the one place a service will
   * actually look: the request.
   *
   * WHAT IT IS NOT. Not an authorization credential. It contains no secret,
   * proves nothing, and a service that trusts it without its own verification
   * is trusting the client to report its own revocation status. It is a
   * staleness hint: `epoch: 3` against a cached `epoch: 1` means two
   * withdrawals happened since, so the cached grant is stale.
   *
   * The recordId here is the local pseudonymous id. Export it and a service
   * can correlate; that correlation is exactly the kind of thing a user should
   * be asked about, which is what SHARE_DERIVED_METADATA covers.
   */
  revocationState() {
    return {
      recordId: this.recordId,
      epoch: this.consentEpoch,
      granted: this.grantedPurposes(),
      at: new Date(this._now()).toISOString(),
    };
  }

  /** Every purpose currently granted. */
  grantedPurposes() {
    return Object.entries(this.purposes)
      .filter(([, e]) => e.state === 'given')
      .map(([id]) => id);
  }

  /**
   * Append an event to the tamper-evident log.
   *
   * Each event also carries a hash of the CURRENT consent state, and this is
   * load-bearing rather than decorative.
   *
   * Without it the chain protected the wrong artifact. `isGranted()` reads
   * `purposes`; `verify()` walks `events`; `toJSON()` serialises them as
   * independent siblings and `fromJSON()` restored both without verifying. So a
   * forged record with `purposes.acquire_signal.state = 'given'` and an EMPTY
   * event log reported `isGranted() === true` AND `verify().ok === true` — the
   * chain vouched for an authorization state it had never witnessed.
   *
   * Verified before the fix: a record with zero events and a hand-written
   * purposes block returned granted:true, chain-intact:true.
   *
   * Hashing the state into every event closes that: altering `purposes` without
   * the corresponding event makes `verify()` fail at the first event whose
   * recorded state no longer matches.
   */
  append(type, payload = {}) {
    const prev = this.events[this.events.length - 1];
    const event = {
      seq: this.events.length,
      type,
      at: new Date(this._now()).toISOString(),
      ...payload,
      prevHash: prev ? prev.hash : 'genesis',
      // The state this event produced. Checked by verify().
      stateHash: stateHashOf(this.purposes),
    };
    event.hash = eventHash(event.prevHash, event);
    this.events.push(event);
    return event;
  }

  /**
   * Walk the event chain only: does each event's hash match its contents and
   * its recorded predecessor?
   *
   * Split out from verify() because the combined answer was being reported
   * under the name `chainIntact`, and the two failure modes are not the same
   * thing. A record whose purposes were edited behind an untouched log has an
   * INTACT chain and a state mismatch — verify() correctly returns ok:false,
   * but reporting that as `chainIntact: false` told a reader the log had been
   * tampered with when it had not. An instrument that misnames which of two
   * things went wrong sends the investigation the wrong way.
   */
  verifyChain() {
    let prevHash = 'genesis';
    for (const event of this.events) {
      if (event.prevHash !== prevHash) return { ok: false, brokenAt: event.seq };
      const expected = eventHash(prevHash, event);
      if (event.hash !== expected) return { ok: false, brokenAt: event.seq };
      prevHash = event.hash;
    }
    return { ok: true, brokenAt: -1 };
  }

  /**
   * Verify the event chain AND that the live consent state matches what the
   * chain recorded.
   *
   * Returns { ok, brokenAt, stateMismatch }.
   *   - brokenAt       — seq of the first event whose hash does not match its
   *                      contents, or -1
   *   - stateMismatch  — true when the event chain is internally sound but
   *                      `purposes` does not match the state the last event
   *                      recorded. That is the signature of an edited record:
   *                      the log is intact and the authorization state was
   *                      changed behind it.
   */
  verify() {
    const chain = this.verifyChain();
    if (!chain.ok) return { ok: false, brokenAt: chain.brokenAt, stateMismatch: false };
    // A record with decisions but no events is not verifiable — it claims an
    // authorization state with no history to support it.
    const last = this.events[this.events.length - 1];
    if (!last) {
      const hasState = Object.keys(this.purposes).length > 0;
      return { ok: !hasState, brokenAt: -1, stateMismatch: hasState };
    }
    if (last.stateHash !== stateHashOf(this.purposes)) {
      return { ok: false, brokenAt: -1, stateMismatch: true };
    }
    return { ok: true, brokenAt: -1, stateMismatch: false };
  }

  /** Serialise for export or storage. */
  toJSON() {
    return {
      schemaVersion: this.schemaVersion,
      recordId: this.recordId,
      subjectId: this.subjectId,
      createdAt: this.createdAt,
      purposes: this.purposes,
      declaration: this.declaration,
      handling: this.handling,
      events: this.events,
      // consentEpoch is deliberately NOT written. It is derived from the events,
      // which are already here, so storing a copy would create a second source
      // of truth for the one number a remote service is asked to trust — and
      // the wrong copy would be the editable one.
    };
  }

  /** Restore from a serialised record. */
  /**
   * Restore from a serialised record.
   *
   * VERIFIES, and fails closed. A record whose chain does not check out, or
   * whose live grant state does not match what the chain recorded, is returned
   * with an EMPTY purpose set — so the gate refuses everything — and the
   * problem is reported on `record.integrity`.
   *
   * The alternative (restoring whatever the file says) is how a tampered record
   * becomes a working grant. Since this is the only path from storage into the
   * gate, it is the right place to be strict.
   */
  static fromJSON(data, options = {}) {
    // The declaration is taken from the caller FIRST, because it is the current
    // truth about the host. A declaration serialised into an old file describes
    // the tool as it was when that file was written — if the host has since
    // added an online path, restoring the stale declaration would put a
    // reassuring "nothing transmitted" back into the record after the fact.
    // Caller-supplied wins; the file's copy is a fallback for a tool that has
    // no way to restate it.
    const rec = new ConsentRecord({
      ...options,
      declaration: options.declaration ?? data.declaration ?? null,
      recordId: data.recordId,
      subjectId: data.subjectId,
      createdAt: data.createdAt,
    });
    rec.schemaVersion = data.schemaVersion ?? SCHEMA_VERSION;
    // handling is DERIVED, never restored verbatim — see the constructor. The
    // stored copy is discarded on purpose: it may predate the current
    // declaration, and a stale recipient list is the exact artifact that must
    // not survive a refresh.
    rec.events = Array.isArray(data.events) ? data.events : [];
    rec.purposes = data.purposes ?? {};

    const integrity = rec.verify();
    rec.integrity = integrity;
    if (!integrity.ok || integrity.stateMismatch) {
      // Fail closed: preserve the evidence, grant nothing.
      rec.purposes = {};
      rec.integrityReason = integrity.stateMismatch
        ? 'consent state does not match the event chain — the record was edited'
        : `event chain broken at seq ${integrity.brokenAt}`;
    }
    return rec;
  }

  /**
   * A human-readable summary — what the person can actually read back.
   *
   * The two integrity facts are reported SEPARATELY and named for what they
   * actually are. See verifyChain() for why the combined `ok` was the wrong
   * thing to label "chainIntact".
   */
  summary() {
    const chain = this.verifyChain();
    const state = this.verify();
    return {
      recordId: this.recordId,
      createdAt: this.createdAt,
      granted: this.grantedPurposes(),
      events: this.events.length,
      chainIntact: chain.ok,
      // Distinct from chainIntact, and the reason this summary was misleading
      // before: a record can have an intact log and a rewritten grant.
      stateMatchesChain: !state.stateMismatch,
      brokenAt: chain.ok ? -1 : chain.brokenAt,
      recipients: this.handling.recipientsDeclaration,
      handlingStated: this.handling.stated,
    };
  }

  _validUntil(fromIso, validDays) {
    if (!validDays || validDays <= 0) return null;
    return new Date(Date.parse(fromIso) + validDays * 86400000).toISOString();
  }
}

/**
 * A local, non-identifying id. Prefers crypto.randomUUID when available, and
 * falls back to a timestamp + random suffix so the module works in any
 * environment without a polyfill. Neither form carries personal data.
 */
export function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
