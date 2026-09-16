/**
 * consent.test.mjs — the gate, the record, and the lifecycle.
 *
 * The tests that matter most are the ones about the gate: a consent layer
 * that records decisions but does not actually prevent processing is
 * documentation, not consent. So the suite checks that require() throws, that
 * withdrawal takes effect immediately, and that a corrupt stored record
 * fails CLOSED (grants nothing) rather than open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConsentManager,
  ConsentRequiredError,
  PURPOSES,
  DISCLAIMER,
  noticeVersion,
  keyInformationText,
} from '../src/index.js';
import { ConsentRecord, fnv1a } from '../src/record.js';

/** An in-memory storage stand-in. */
function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
    _dump: () => Object.fromEntries(store),
  };
}

const ACQ = PURPOSES.ACQUIRE_SIGNAL.id;

// -- the gate ---------------------------------------------------------------

test('nothing is granted on a fresh install', () => {
  const consent = new ConsentManager();
  for (const p of Object.values(PURPOSES)) {
    assert.equal(consent.isGranted(p.id), false, `${p.id} must start ungranted`);
  }
});

test('require() throws when consent is absent — the gate actually gates', () => {
  const consent = new ConsentManager();
  assert.throws(() => consent.require(ACQ), ConsentRequiredError);
  try {
    consent.require(ACQ);
  } catch (e) {
    assert.equal(e.purposeId, ACQ, 'the error names which purpose was missing');
    assert.equal(e.name, 'ConsentRequiredError');
  }
});

test('require() passes once consent is granted', () => {
  const consent = new ConsentManager();
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  assert.equal(consent.require(ACQ), true);
  assert.equal(consent.isGranted(ACQ), true);
});

test('withdrawal takes effect immediately and the gate closes again', () => {
  const consent = new ConsentManager();
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  assert.equal(consent.isGranted(ACQ), true);
  consent.withdraw(ACQ);
  assert.equal(consent.isGranted(ACQ), false, 'withdrawal must be immediate');
  assert.throws(() => consent.require(ACQ), ConsentRequiredError);
});

test('purposes are independent — granting one does not grant another', () => {
  const consent = new ConsentManager();
  consent.grant(PURPOSES.ACQUIRE_SIGNAL.id, { noticeVersion: noticeVersion() });
  assert.equal(consent.isGranted(PURPOSES.PROCESS_LOCALLY.id), false,
    'purpose limitation: consent to one thing must not authorise another');
  assert.equal(consent.granted().length, 1);
});

test('refusal is recorded rather than discarded', () => {
  const consent = new ConsentManager();
  consent.refuse(PURPOSES.PERSIST_LOCALLY.id, { noticeVersion: noticeVersion() });
  assert.equal(consent.stateOf(PURPOSES.PERSIST_LOCALLY.id), 'refused');
  assert.equal(consent.isGranted(PURPOSES.PERSIST_LOCALLY.id), false);
});

test('granting an unknown purpose is rejected', () => {
  const consent = new ConsentManager();
  assert.throws(() => consent.grant('made_up_purpose'), /unknown purpose/);
});

// -- lifecycle --------------------------------------------------------------

test('consent expires when its validity window lapses', () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const consent = new ConsentManager({ now: () => now, validDays: 30 });
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  assert.equal(consent.isGranted(ACQ), true);

  now = Date.parse('2026-01-15T00:00:00Z'); // inside the window
  assert.equal(consent.isGranted(ACQ), true);

  now = Date.parse('2026-03-01T00:00:00Z'); // well past it
  const lapsed = consent.record.expireLapsed();
  assert.deepEqual(lapsed, [ACQ], 'the lapsed purpose is reported');
  assert.equal(consent.isGranted(ACQ), false, 'an expired grant stops working');
});

test('expiry is applied on load, so a stale record is not silently valid', () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const storage = fakeStorage();
  const first = new ConsentManager({ storage, now: () => now, validDays: 10 });
  first.grant(ACQ, { noticeVersion: noticeVersion() });

  // A year later, with the same storage.
  now = Date.parse('2027-01-01T00:00:00Z');
  const second = new ConsentManager({ storage, now: () => now, validDays: 10 });
  assert.equal(second.isGranted(ACQ), false, 'loading must expire stale consent');
});

test('withdrawAll turns everything off in one action', () => {
  const consent = new ConsentManager();
  for (const p of Object.values(PURPOSES)) consent.grant(p.id, { noticeVersion: noticeVersion() });
  assert.equal(consent.granted().length, 4);
  const events = consent.withdrawAll();
  assert.equal(events.length, 4);
  assert.equal(consent.granted().length, 0);
});

test('re-affirmation is recorded (Colorado requires periodic refresh)', () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const consent = new ConsentManager({ now: () => now, validDays: 30 });
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  const firstExpiry = consent.record.purposes[ACQ].validUntil;
  const before = consent.record.events.length;

  // Re-affirm 20 days in, before the window lapses.
  now = Date.parse('2026-01-21T00:00:00Z');
  consent.reaffirm(ACQ, { noticeVersion: noticeVersion() });

  assert.ok(consent.record.events.length > before, 'a re-affirmation is an event');
  assert.equal(consent.isGranted(ACQ), true);
  const secondExpiry = consent.record.purposes[ACQ].validUntil;
  assert.ok(Date.parse(secondExpiry) > Date.parse(firstExpiry),
    're-affirming must reset the validity window forward');
});

// -- the record -------------------------------------------------------------

test('the record carries the 27560-shaped fields', () => {
  const consent = new ConsentManager();
  consent.grant(ACQ, { noticeVersion: 'v-test-1', language: 'en' });
  const entry = consent.record.purposes[ACQ];
  assert.equal(entry.noticeVersion, 'v-test-1', 'what the user actually agreed to');
  assert.equal(entry.language, 'en');
  assert.equal(entry.sensitivity, 'neural', 'the record is self-describing');
  assert.equal(entry.purposeId, ACQ);
  assert.ok(entry.grantedAt, 'grant time is recorded');
  assert.ok(entry.validUntil, 'validity duration is recorded');
  assert.ok(entry.withdrawalMethod, '27560 requires a named withdrawal path');
  assert.ok(entry.dataTypes !== undefined);
});

test('recipients are declared as none — the machine-readable privacy claim', () => {
  const consent = new ConsentManager();
  assert.deepEqual(consent.record.handling.recipients, []);
  assert.equal(consent.record.handling.recipientsDeclaration, 'none — no transmission');
  assert.equal(consent.record.handling.storage, 'local-only');
});

test('the record states which 27560 fields were deliberately omitted', () => {
  // Blindly copying an inter-organisational standard would import fields
  // that only exist to exchange records between organisations. Documenting
  // the omission is the honest alternative to silently dropping them.
  const consent = new ConsentManager();
  const omitted = consent.record.handling.omittedFields;
  assert.ok(omitted.includes('pii_controller_address'));
  assert.ok(omitted.includes('jurisdiction'));
  assert.ok(omitted.includes('authority_party'));
});

test('the event log chains and verifies', () => {
  const consent = new ConsentManager();
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  consent.withdraw(ACQ);
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  const v = consent.record.verify();
  assert.equal(v.ok, true, 'an untouched chain verifies');
  assert.ok(consent.record.events.length >= 3);
});

test('tampering with a past event is detected', () => {
  const consent = new ConsentManager();
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  consent.withdraw(ACQ);
  // Retroactively change history: pretend the withdrawal never happened.
  consent.record.events[1].type = 'grant';
  const v = consent.record.verify();
  assert.equal(v.ok, false, 'an altered event must break the chain');
  assert.equal(v.brokenAt, 1, 'and the break is located');
});

test('removing an event is detected', () => {
  const consent = new ConsentManager();
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  consent.withdraw(ACQ);
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  consent.record.events.splice(1, 1); // drop the withdrawal
  assert.equal(consent.record.verify().ok, false, 'a missing event breaks the chain');
});

// -- CRITICAL: the chain must witness the AUTHORIZATION state ----------------

test('CRITICAL: a forged grant is detected — the chain covers the gate state', () => {
  // Before the fix the chain protected the wrong artifact. isGranted() reads
  // `purposes`; verify() walked `events`; fromJSON restored both independently
  // and never verified. So a record with a hand-written purposes block and an
  // EMPTY event log reported granted:true AND chain-ok:true — the chain
  // vouched for an authorization state it had never witnessed.
  const forged = new ConsentRecord({ now: () => 1000 });
  forged.purposes = {
    acquire_signal: {
      purposeId: 'acquire_signal', state: 'given', noticeVersion: 'v1', language: 'en',
      dataTypes: [], sensitivity: 'neural', grantedAt: new Date(1000).toISOString(),
      validUntil: null, withdrawalMethod: 'x', legalBasis: 'consent',
    },
  };
  forged.events = []; // never consented — no history at all

  const v = forged.verify();
  assert.equal(v.ok, false, 'a state with no events must not verify');
  assert.equal(v.stateMismatch, true, 'and the mismatch is reported as such');
});

test('CRITICAL: tampering with purposes after a real grant breaks verification', () => {
  const rec = new ConsentRecord({ now: () => 1000 });
  rec.decide('acquire_signal', 'given', { noticeVersion: 'v1' });
  assert.equal(rec.verify().ok, true, 'an untouched record verifies');

  // Swap the state behind the log's back — the realistic tamper.
  rec.purposes.acquire_signal.state = 'withdrawn';
  const v = rec.verify();
  assert.equal(v.stateMismatch, true, 'the edited state must be detectable');
  assert.equal(v.ok, false);
});

test('CRITICAL: fromJSON refuses a tampered record and grants NOTHING', () => {
  // Fail closed. The alternative — restoring whatever the file says — is how a
  // tampered record becomes a working grant.
  const rec = new ConsentRecord({ now: () => 1000 });
  rec.decide('acquire_signal', 'given', { noticeVersion: 'v1' });

  const json = rec.toJSON();
  json.purposes.acquire_signal.validUntil = null; // edit outside the log
  json.purposes.some_new_purpose = { purposeId: 'some_new_purpose', state: 'given' };

  const restored = ConsentRecord.fromJSON(json, { now: () => 1000 });
  assert.equal(restored.isGranted('acquire_signal'), false, 'a tampered record grants nothing');
  assert.equal(restored.isGranted('some_new_purpose'), false, 'nor does an invented purpose');
  assert.ok(restored.integrityReason, 'and it says why');
  assert.ok(/edited|broken/i.test(restored.integrityReason));
});

test('an HONEST round-trip still restores granted state', () => {
  // The fix must not break the legitimate path.
  const rec = new ConsentRecord({ now: () => 1000 });
  rec.decide('acquire_signal', 'given', { noticeVersion: 'v1' });
  const restored = ConsentRecord.fromJSON(rec.toJSON(), { now: () => 1000 });
  assert.equal(restored.isGranted('acquire_signal'), true, 'an untampered record restores');
  assert.equal(restored.integrityReason, null);
});

// -- persistence ------------------------------------------------------------

test('a grant survives a reload through storage', () => {
  const storage = fakeStorage();
  const first = new ConsentManager({ storage });
  first.grant(ACQ, { noticeVersion: noticeVersion() });

  const second = new ConsentManager({ storage });
  assert.equal(second.isGranted(ACQ), true, 'consent persists locally');
});

test('a corrupt stored record fails CLOSED, granting nothing', () => {
  const storage = fakeStorage({ 'neural-consent.record': '{ not valid json' });
  const consent = new ConsentManager({ storage });
  assert.equal(consent.granted().length, 0,
    'a corrupt record must not become a permissive one');
});

test('erase removes the local record', () => {
  const storage = fakeStorage();
  const consent = new ConsentManager({ storage });
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  consent.erase();
  assert.equal(consent.granted().length, 0);
  assert.equal(storage.getItem('neural-consent.record'), null);
});

test('export produces a re-importable record', () => {
  const consent = new ConsentManager();
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  const json = consent.export();
  const restored = ConsentRecord.fromJSON(JSON.parse(json));
  assert.equal(restored.isGranted(ACQ), true, 'the exported record round-trips');
  assert.equal(restored.verify().ok, true, 'and its chain is intact');
});

// -- the disclaimer and the notice ------------------------------------------

test('the disclaimer refuses to claim compliance', () => {
  const text = (DISCLAIMER.short + ' ' + DISCLAIMER.full).toLowerCase();
  // The claims a tool must NOT make. Each of these is either false for a
  // local-first tool or depends on facts about the publisher.
  for (const forbidden of ['ccpa compliant', 'gdpr compliant', 'hipaa compliant',
    'fda cleared', 'certified', 'privacy-compliant by architecture']) {
    assert.ok(!text.includes(forbidden), `disclaimer must not claim "${forbidden}"`);
  }
  assert.ok(text.includes('does not claim'), 'it must say what it is not');
  assert.ok(text.includes('not transmitted'), 'and state the thing that IS true');
});

test('every purpose has both a key text and a detail text', () => {
  for (const p of Object.values(PURPOSES)) {
    assert.ok(p.keyText.length > 20, `${p.id} needs a concise key text`);
    assert.ok(p.detailText.length > 40, `${p.id} needs a fuller detail text`);
    assert.ok(p.version, `${p.id} needs a version so the record is reconstructable`);
    // Layered presentation is the Common Rule's model (45 CFR 46.116(a)(5)(i)).
    assert.ok(p.detailText.length > p.keyText.length, `${p.id}: detail must add detail`);
  }
});

test('the key-information text is short enough to actually read first', () => {
  const text = keyInformationText();
  // The Common Rule asks for "concise and focused". A screen-reader user
  // should be able to hear this before deciding.
  assert.ok(text.split(/\s+/).length < 130, 'key information must stay brief');
});

test('notice version is stable and names each purpose', () => {
  const v = noticeVersion();
  assert.equal(v, noticeVersion(), 'the version must be deterministic');
  for (const p of Object.values(PURPOSES)) {
    assert.ok(v.includes(p.id), `the version names ${p.id}`);
  }
});

test('the snapshot carries the disclaimer to whatever renders it', () => {
  const consent = new ConsentManager();
  const snap = consent.snapshot();
  assert.ok(snap.disclaimer, 'a UI cannot forget to include the disclaimer');
  assert.equal(snap.purposes.length, 4);
  assert.ok(snap.chain.ok);
});

test('change listeners fire on decisions and can unsubscribe', () => {
  const consent = new ConsentManager();
  const seen = [];
  const off = consent.onChange((e) => seen.push(e.type));
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  consent.withdraw(ACQ);
  off();
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  assert.deepEqual(seen, ['grant', 'withdraw'], 'unsubscribe stops delivery');
});

test('fnv1a is deterministic and order-sensitive', () => {
  assert.equal(fnv1a('abc'), fnv1a('abc'));
  assert.notEqual(fnv1a('abc'), fnv1a('acb'));
});
