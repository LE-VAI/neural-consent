/**
 * consent.js — the manager a tool actually talks to.
 *
 * The point of this layer is that the REST of the tool asks permission before
 * doing anything with a signal. A consent screen that records a decision but
 * does not gate behaviour is documentation, not consent. So the API is shaped
 * as a gate:
 *
 *   if (!consent.isGranted(PURPOSES.ACQUIRE_SIGNAL.id)) return;  // do not read
 *
 * and `require()` throws rather than returning a falsy value, because a
 * silently-skipped permission check is how consent gets bypassed by accident.
 *
 * PERSISTENCE IS OPTIONAL AND LOCAL. When a storage object is supplied the
 * record is written to it; when it is not, everything lives in memory for the
 * session. No network path exists in this module at all — there is no fetch,
 * no beacon, no endpoint configuration. That absence is the feature: it is
 * what makes the library's own no-transmission statement true, and
 * `scripts/audit-no-network.py` fails CI if it ever stops being true.
 *
 * A NOTE ON WHAT THIS LIBRARY MAY CLAIM. It can state facts about itself. It
 * cannot state facts about the tool around it — that tool may add an online
 * path tomorrow, and this library would have no way to know. So the record's
 * recipient fields and the displayed disclaimer are both built from a
 * `declaration` the host supplies, and report "unstated" when it does not.
 */

import { ConsentRecord, generateId } from './record.js';
import {
  PURPOSES,
  CORE_PURPOSES,
  DEFAULT_PURPOSES,
  ALL_PURPOSES,
  DISCLAIMER,
  SIGNAL_HANDLING,
  DERIVED_METADATA_HANDLING,
  noticeVersion,
  purposeById,
  resolvePurposes,
  normalizeDeclaration,
  declarationText,
  disclaimerText,
  keyInformationText,
} from './notices.js';

export {
  PURPOSES,
  CORE_PURPOSES,
  DEFAULT_PURPOSES,
  ALL_PURPOSES,
  DISCLAIMER,
  SIGNAL_HANDLING,
  DERIVED_METADATA_HANDLING,
  noticeVersion,
  purposeById,
  resolvePurposes,
  normalizeDeclaration,
  declarationText,
  disclaimerText,
  keyInformationText,
};

export class ConsentManager {
  /**
   * @param {object} [options]
   * @param {object} [options.storage] an object with getItem/setItem/removeItem
   *   (e.g. window.localStorage). Omit for in-memory only.
   * @param {string} [options.storageKey='neural-consent.record']
   * @param {string} [options.recordId]
   * @param {Function} [options.now] injected clock
   * @param {number} [options.validDays=365] validity window for a grant
   * @param {string} [options.language='en']
   * @param {object} [options.declaration] what THIS TOOL does with signal and
   *   derived data. See normalizeDeclaration. Omit and the record says
   *   "unstated" — which is the honest default for a library that cannot know.
   * @param {string[]} [options.purposes] ids the tool presents. Defaults to the
   *   four local-first purposes; a tool with an online feature adds
   *   'share_derived_metadata' explicitly.
   * @param {boolean} [options.retainErasureLog=true] keep a hash-only tombstone
   *   of the erased record so a withdrawal cannot be erased out of existence
   */
  constructor(options = {}) {
    this.storage = options.storage ?? null;
    this.storageKey = options.storageKey ?? 'neural-consent.record';
    this.erasureKey = options.erasureKey ?? `${this.storageKey}.erased`;
    this.validDays = options.validDays ?? 365;
    this.language = options.language ?? 'en';
    this.recordId = options.recordId ?? null;
    this.retainErasureLog = options.retainErasureLog !== false;
    this._now = options.now ?? (() => Date.now());

    /**
     * The purposes this tool presents. Resolved eagerly so a typo fails at
     * construction rather than at the moment a user is looking at a consent
     * screen.
     */
    this.purposes = resolvePurposes(
      options.purposes ?? DEFAULT_PURPOSES.map((p) => p.id)
    );

    /**
     * What the tool declares about itself. Normalized here and re-normalized
     * by setDeclaration(), so an incoherent declaration (says it shares
     * derived data but names no recipient) is refused rather than displayed
     * next to a consent screen where it would read as reassurance.
     */
    this.declaration = normalizeDeclaration(options.declaration, this._now);

    /** Change listeners — a UI subscribes to re-render on any decision. */
    this._listeners = new Set();

    this.record = this._load();
    // Consent should lapse. Expiring on load means a record that sat unused
    // past its window is correctly inert rather than silently still valid.
    const lapsed = this.record.expireLapsed();
    if (lapsed.length) this._emit({ type: 'expired', purposes: lapsed });
  }

  // -- the gate --------------------------------------------------------------

  /** True only while consent is currently held for the purpose. */
  isGranted(purposeId) {
    return this.record.isGranted(purposeId);
  }

  /**
   * Throw unless consent is held. Use this where processing must not happen
   * without it — a falsy return that a caller forgets to check is how a gate
   * silently stops gating.
   */
  require(purposeId) {
    if (!this.isGranted(purposeId)) {
      throw new ConsentRequiredError(purposeId);
    }
    return true;
  }

  /** Every purpose currently granted. */
  granted() {
    return this.record.grantedPurposes();
  }

  /** True if this tool presents the given purpose at all. */
  presents(purposeId) {
    return this.purposes.some((p) => p.id === purposeId);
  }

  /**
   * Grant consent for a purpose. The notice version shown MUST be passed in
   * by the UI — the manager will not guess it, because the record has to
   * reflect the text the person actually read.
   *
   * @param {string} purposeId
   * @param {object} [meta]
   * @param {string} meta.noticeVersion
   */
  grant(purposeId, meta = {}) {
    const def = purposeById(purposeId);
    if (!def) throw new Error(`unknown purpose: ${purposeId}`);
    this._assertExplicit(purposeId, def, meta);
    const event = this.record.decide(purposeId, 'given', {
      noticeVersion: meta.noticeVersion ?? noticeVersion(this.purposes),
      language: meta.language ?? this.language,
      validDays: meta.validDays ?? this.validDays,
      dataTypes: meta.dataTypes ?? [],
      withdrawalMethod: meta.withdrawalMethod,
    });
    this._persist();
    this._emit({ type: 'grant', purposeId });
    return event;
  }

  /**
   * Refuse a purpose. Refusal is recorded, not discarded.
   *
   * Not gated by _assertExplicit: refusing an opt-in purpose can never be the
   * dangerous direction.
   */
  refuse(purposeId, meta = {}) {
    if (!purposeById(purposeId)) throw new Error(`unknown purpose: ${purposeId}`);
    const event = this.record.decide(purposeId, 'refused', {
      noticeVersion: meta.noticeVersion ?? noticeVersion(this.purposes),
      language: meta.language ?? this.language,
    });
    this._persist();
    this._emit({ type: 'refuse', purposeId });
    return event;
  }

  /** Withdraw a grant. Immediate, symmetric, and logged. */
  withdraw(purposeId, meta = {}) {
    const event = this.record.withdraw(purposeId, meta);
    if (event) {
      this._persist();
      this._emit({ type: 'withdraw', purposeId });
    }
    return event;
  }

  /**
   * Re-affirm an existing grant, resetting its validity window.
   *
   * Colorado's rules require periodic consent refresh for sensitive data, and
   * a validity window that can only expire — never renew — would leave a user
   * re-consenting from scratch every cycle. Re-affirmation is the same
   * decision, re-taken deliberately, recorded as its own event.
   */
  reaffirm(purposeId, meta = {}) {
    const def = purposeById(purposeId);
    if (!def) throw new Error(`unknown purpose: ${purposeId}`);
    this._assertExplicit(purposeId, def, meta);
    const existing = this.record.purposes[purposeId];
    if (!existing) throw new Error(`no consent recorded for purpose: ${purposeId}`);
    const event = this.record.decide(purposeId, 'given', {
      noticeVersion: meta.noticeVersion ?? existing.noticeVersion,
      language: meta.language ?? this.language,
      validDays: meta.validDays ?? this.validDays,
      dataTypes: meta.dataTypes ?? existing.dataTypes,
      withdrawalMethod: meta.withdrawalMethod ?? existing.withdrawalMethod,
    });
    this._persist();
    this._emit({ type: 'reaffirm', purposeId });
    return event;
  }

  /**
   * Withdraw everything at once — the "turn it all off" path.
   *
   * Also withdraws purposes this tool does not presently present, if a record
   * restored from storage contains them. A grant that exists in the record is
   * a grant the gate will honour, so "turn it all off" has to mean all of it,
   * not just the ones on the current screen. A purpose the user can no longer
   * see but which is still granted is the worst kind of leftover.
   */
  withdrawAll(meta = {}) {
    const ids = this.granted();
    const events = ids.map((id) => this.record.withdraw(id, meta)).filter(Boolean);
    if (events.length) {
      this._persist();
      this._emit({ type: 'withdraw-all', purposes: ids });
    }
    return events;
  }

  // -- declaration -----------------------------------------------------------

  /**
   * Update what this tool declares about its own handling.
   *
   * Separate from consent decisions on purpose: a declaration is a statement
   * about the tool, not a permission. Changing it does not alter any grant —
   * but it DOES change what the record claims, so the change is recorded as an
   * event. Otherwise a tool could revise its disclosure while leaving the
   * evidence untouched, which is the same shape as editing the record.
   */
  setDeclaration(declaration) {
    const normalized = normalizeDeclaration(declaration, this._now);
    if (declaration && !normalized) {
      throw new Error(
        'declaration is incomplete or contradictory — a tool that shares derived ' +
        'data must name recipients, and one that shares nothing must not name any'
      );
    }
    this.declaration = normalized;
    this.record.declaration = normalized;
    this.record.handling = this.record.declaredHandling;
    this.record.append('declare', { handling: this.record.handling });
    this._persist();
    this._emit({ type: 'declare' });
    return normalized;
  }

  /** Render the tool's declaration, or the statement that it made none. */
  declarationText() {
    return declarationText(this.declaration);
  }

  /** The full disclaimer with the tool's declaration attached — what to show. */
  disclaimerText() {
    return disclaimerText(this.declaration);
  }

  // -- inspection ------------------------------------------------------------

  /** State of one purpose, or null if never decided. */
  stateOf(purposeId) {
    return this.record.purposes[purposeId]?.state ?? null;
  }

  /**
   * A snapshot the UI renders from. Includes the disclaimer, always.
   *
   * `purposes` lists only what this tool PRESENTS, but `granted` reports every
   * grant the gate would honour — including one restored from storage for a
   * purpose no longer offered. A UI that renders the first and not the second
   * would show a clean screen over a live grant; see withdrawAll().
   */
  snapshot() {
    const granted = this.record.grantedPurposes();
    const presented = this.purposes.map((p) => p.id);
    return {
      recordId: this.record.recordId,
      createdAt: this.record.createdAt,
      // The gate's answer, so a UI does not have to re-derive it and get it
      // wrong. A consent screen that shows the wrong state is worse than none.
      granted,
      // Grants that exist but are not on the current screen. Non-empty here is
      // a bug in the host's setup or a stale record, and either way the user
      // should be able to see and revoke it.
      grantedButNotPresented: granted.filter((id) => !presented.includes(id)),
      purposes: this.purposes.map((p) => ({
        id: p.id,
        label: p.label,
        keyText: p.keyText,
        detailText: p.detailText,
        version: p.version,
        requiresExplicitGrant: p.requiresExplicitGrant === true,
        state: this.stateOf(p.id),
        entry: this.record.purposes[p.id] ?? null,
      })),
      disclaimer: DISCLAIMER,
      // The disclaimer with the tool's own declaration appended. This is the
      // string a UI should render — DISCLAIMER.full alone describes only what
      // is true of the library and says nothing about the tool.
      disclaimerText: this.disclaimerText(),
      declaration: this.declaration,
      declarationText: this.declarationText(),
      handling: this.record.handling,
      chain: this.record.verify(),
      chainIntact: this.record.verifyChain().ok,
      consentEpoch: this.record.consentEpoch,
      eventCount: this.record.events.length,
      erasure: this.erasureInfo(),
    };
  }

  /** Subscribe to decisions. Returns an unsubscribe function. */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(evt) {
    for (const fn of this._listeners) {
      try { fn(evt, this.snapshot()); } catch { /* a bad listener must not break the gate */ }
    }
  }

  /**
   * An opt-in purpose must be granted one way: by a caller who passes
   * `explicit: true` AND the notice version of THAT purpose's own text.
   *
   * WHY THE SECOND REQUIREMENT. `explicit: true` alone is context-free — the
   * same token grants anything, so a host writing
   * `for (const p of purposes) grant(p.id, { explicit: true })` carries the
   * opt-in purpose along with the four core permissions. That loop is one line
   * of ordinary code and it defeats the flag entirely.
   *
   * Requiring the SINGLE-purpose notice version makes such a loop fail. The
   * bundle version is `acquire_signal@1.0.0+export@1.0.0+...`; the value this
   * method accepts for the opt-in purpose is `share_derived_metadata@1.0.0`,
   * which contains no other purpose. A caller cannot produce it by accident or
   * by passing whatever version the UI happened to compute for the whole
   * screen — they have to name this one notice.
   *
   * WHY NOT SOMETHING STRONGER. No client-side API can prove a person read a
   * screen; any guard is defeatable by code written to defeat it. What is
   * achievable is that the ACCIDENTAL paths are closed (batch loops, config
   * defaults, "grant all recommended", a version computed for the whole panel)
   * and the deliberate path is conspicuous: the line that grants this has to
   * name the purpose's own notice and assert explicitness. That line is worth
   * a reviewer's attention, which is the real protection.
   *
   * A text change to the opt-in notice bumps its version and invalidates the
   * old value, so re-consent cannot ride on a stale version string.
   */
  _assertExplicit(purposeId, def, meta) {
    if (def.requiresExplicitGrant !== true) return;
    if (meta.explicit !== true) {
      throw new Error(
        `${purposeId} requires an explicit grant: pass { explicit: true, ` +
        `noticeVersion: <its own version> } after showing its notice text. It ` +
        'must never be granted in a batch, implied by another purpose, or set ' +
        'from a default.'
      );
    }
    // The notice version must name THIS purpose and no other, so a version
    // computed for a whole panel cannot carry it.
    const own = noticeVersion([def]);
    const given = meta.noticeVersion;
    if (given !== own) {
      throw new Error(
        `${purposeId} requires the notice version of its own text ` +
        `(${own}), not ${given === undefined ? 'an omitted value' : `"${given}"`}. ` +
        'A version covering several purposes cannot authorise an opt-in one — ' +
        'that is how it would travel with a batch.'
      );
    }
  }

  // -- persistence -----------------------------------------------------------

  _load() {
    if (this.storage) {
      try {
        const raw = this.storage.getItem(this.storageKey);
        if (raw) {
          const data = JSON.parse(raw);
          // The CURRENT declaration is passed, not the one in the file — a
          // stale "nothing transmitted" must not be restored over a tool that
          // has since added an online path.
          return ConsentRecord.fromJSON(data, {
            now: this._now,
            declaration: this.declaration,
          });
        }
      } catch {
        // A corrupt record must not silently become a fresh one with
        // everything granted. Fall through to an empty record, which grants
        // nothing — the fail-closed direction.
      }
    }
    return new ConsentRecord({
      now: this._now,
      recordId: this.recordId ?? generateId(),
      declaration: this.declaration,
    });
  }

  _persist() {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.record.toJSON()));
    } catch {
      // Storage may be unavailable (private mode, quota). Consent stays valid
      // for the session; it simply will not survive a reload.
    }
  }

  /** Export the record — the portability path the user controls. */
  export() {
    return JSON.stringify(this.record.toJSON(), null, 2);
  }

  /**
   * Erase the record, keeping a hash-only tombstone.
   *
   * THE BUG THIS FIXES. `erase()` used to delete the record and emit
   * `{ type: 'erase' }` — but that event goes to in-memory listeners, and the
   * record it described was already gone from storage. The next load produced
   * a record that had never been granted anything, indistinguishable from a
   * user who never consented. So the strongest, most protective action a user
   * can take (make it all stop, leave no trace) destroyed the very evidence
   * that the withdrawal happened. A user whose concern is "prove I withdrew
   * before you used my data" was worse off after erasing than before.
   *
   * WHAT THE TOMBSTONE IS. A tiny, hash-only record under a separate key:
   * record id, when it was erased, how many withdrawals the record contained,
   * and a hash of the final event chain. No purposes, no timings, no signal
   * metadata, no settings — it cannot reconstruct anything about what the user
   * did, only that this record existed and was deliberately ended.
   *
   * WHY NOT JUST KEEP EVERYTHING. Because erasure is a real right and a real
   * request, and a library that quietly keeps a full copy to serve the second
   * user is violating the first. The tombstone is the smallest artifact that
   * serves "I withdrew and can show it" without serving "here is what I did."
   *
   * @param {{reason?: string, keepTombstone?: boolean}} [meta]
   */
  erase(meta = {}) {
    const before = {
      recordId: this.record.recordId,
      epochs: this.record.consentEpoch,
      granted: this.record.grantedPurposes(),
      events: this.record.events.length,
      chainHash: this.record.events.length
        ? this.record.events[this.record.events.length - 1].hash
        : null,
    };

    if (this.retainErasureLog && meta.keepTombstone !== false) {
      const tombstone = {
        schemaVersion: '1.0.0',
        recordId: before.recordId,
        erasedAt: new Date(this._now()).toISOString(),
        withdrawalCount: before.epochs,
        eventCount: before.events,
        // The chain head: proves the record existed and what its last state
        // hash was, without revealing any of the events that produced it.
        chainHead: before.chainHash,
        reason: meta.reason ?? 'user request',
        // Explicit, so a reader of this file knows what it is NOT.
        containsPersonalData: false,
        note: 'Hash-only tombstone. Records that a consent record was erased, not what it contained.',
      };
      this._writeTombstone(tombstone);
    } else {
      this._clearTombstone();
    }

    // A fresh record, so the gate immediately refuses everything. The new id
    // is deliberate: the erased record's id must not be silently reused, or a
    // service correlating on recordId would see the same id as before.
    this.record = new ConsentRecord({ now: this._now, declaration: this.declaration });
    if (this.storage) {
      try { this.storage.removeItem(this.storageKey); } catch { /* nothing to remove */ }
    }
    this._emit({ type: 'erase', erased: before });
    return before;
  }

  /** What the tombstone currently says, if there is one. */
  erasureInfo() {
    if (!this.storage || !this.retainErasureLog) return null;
    try {
      const raw = this.storage.getItem(this.erasureKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  _writeTombstone(tombstone) {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.erasureKey, JSON.stringify(tombstone));
    } catch { /* private mode: erasure still happens, the tombstone is lost */ }
  }

  _clearTombstone() {
    if (!this.storage) return;
    try { this.storage.removeItem(this.erasureKey); } catch { /* nothing to remove */ }
  }
}

/** Thrown when processing is attempted without consent. */
export class ConsentRequiredError extends Error {
  constructor(purposeId) {
    super(`consent required for: ${purposeId}`);
    this.name = 'ConsentRequiredError';
    this.purposeId = purposeId;
  }
}
