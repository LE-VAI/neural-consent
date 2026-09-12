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
 * what makes the "recipients: none" declaration in the record true rather
 * than aspirational.
 */

import { ConsentRecord, generateId } from './record.js';
import { PURPOSES, DISCLAIMER, noticeVersion, purposeById } from './notices.js';

export { PURPOSES, DISCLAIMER, noticeVersion, purposeById };

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
   */
  constructor(options = {}) {
    this.storage = options.storage ?? null;
    this.storageKey = options.storageKey ?? 'neural-consent.record';
    this.validDays = options.validDays ?? 365;
    this.language = options.language ?? 'en';
    this.recordId = options.recordId ?? null;
    this._now = options.now ?? (() => Date.now());

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
    if (!purposeById(purposeId)) throw new Error(`unknown purpose: ${purposeId}`);
    const event = this.record.decide(purposeId, 'given', {
      noticeVersion: meta.noticeVersion ?? noticeVersion(),
      language: meta.language ?? this.language,
      validDays: meta.validDays ?? this.validDays,
      dataTypes: meta.dataTypes ?? [],
      withdrawalMethod: meta.withdrawalMethod,
    });
    this._persist();
    this._emit({ type: 'grant', purposeId });
    return event;
  }

  /** Decline a purpose. Refusal is recorded, not discarded. */
  refuse(purposeId, meta = {}) {
    if (!purposeById(purposeId)) throw new Error(`unknown purpose: ${purposeId}`);
    const event = this.record.decide(purposeId, 'refused', {
      noticeVersion: meta.noticeVersion ?? noticeVersion(),
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
    if (!purposeById(purposeId)) throw new Error(`unknown purpose: ${purposeId}`);
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

  /** Withdraw everything at once — the "turn it all off" path. */
  withdrawAll(meta = {}) {
    const ids = this.granted();
    const events = ids.map((id) => this.record.withdraw(id, meta)).filter(Boolean);
    if (events.length) {
      this._persist();
      this._emit({ type: 'withdraw-all', purposes: ids });
    }
    return events;
  }

  // -- inspection ------------------------------------------------------------

  /** State of one purpose, or null if never decided. */
  stateOf(purposeId) {
    return this.record.purposes[purposeId]?.state ?? null;
  }

  /** A snapshot the UI renders from. Includes the disclaimer, always. */
  snapshot() {
    const granted = this.record.grantedPurposes();
    return {
      recordId: this.record.recordId,
      createdAt: this.record.createdAt,
      // The gate's answer, so a UI does not have to re-derive it and get it
      // wrong. A consent screen that shows the wrong state is worse than none.
      granted,
      purposes: Object.values(PURPOSES).map((p) => ({
        id: p.id,
        label: p.label,
        keyText: p.keyText,
        detailText: p.detailText,
        version: p.version,
        state: this.stateOf(p.id),
        entry: this.record.purposes[p.id] ?? null,
      })),
      disclaimer: DISCLAIMER,
      handling: this.record.handling,
      chain: this.record.verify(),
      eventCount: this.record.events.length,
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

  // -- persistence -----------------------------------------------------------

  _load() {
    if (this.storage) {
      try {
        const raw = this.storage.getItem(this.storageKey);
        if (raw) {
          const data = JSON.parse(raw);
          return ConsentRecord.fromJSON(data, { now: this._now });
        }
      } catch {
        // A corrupt record must not silently become a fresh one with
        // everything granted. Fall through to an empty record, which grants
        // nothing — the fail-closed direction.
      }
    }
    return new ConsentRecord({ now: this._now, recordId: this.recordId ?? generateId() });
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

  /** Erase everything, locally. */
  erase() {
    this.record = new ConsentRecord({ now: this._now });
    if (this.storage) {
      try { this.storage.removeItem(this.storageKey); } catch { /* nothing to remove */ }
    }
    this._emit({ type: 'erase' });
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
