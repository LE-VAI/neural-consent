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
  CORE_PURPOSES,
  DEFAULT_PURPOSES,
  ALL_PURPOSES,
  DISCLAIMER,
  SIGNAL_HANDLING,
  DERIVED_METADATA_HANDLING,
  noticeVersion,
  keyInformationText,
  normalizeDeclaration,
  declarationText,
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
  for (const p of ALL_PURPOSES) {
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
  // The opt-in purpose is added explicitly here, because a tool that presents
  // it must say so — and granting it needs { explicit: true }.
  const withOptIn = new ConsentManager({
    purposes: ALL_PURPOSES.map((p) => p.id),
  });
  withOptIn.grant(ACQ, { noticeVersion: noticeVersion() });
  for (const id of ['process_locally', 'persist_locally', 'export']) {
    withOptIn.grant(id, { noticeVersion: noticeVersion() });
  }
  withOptIn.grant(PURPOSES.SHARE_DERIVED_METADATA.id, {
    noticeVersion: noticeVersion([PURPOSES.SHARE_DERIVED_METADATA]), explicit: true,
  });
  assert.equal(withOptIn.granted().length, 5);

  const events = withOptIn.withdrawAll();
  assert.equal(events.length, 5);
  assert.equal(withOptIn.granted().length, 0);

  // The default manager still has its own four.
  for (const p of DEFAULT_PURPOSES) consent.grant(p.id, { noticeVersion: noticeVersion() });
  assert.equal(consent.granted().length, 4);
  assert.equal(consent.withdrawAll().length, 4);
});

test('withdrawAll also revokes a grant that is not on the current screen', () => {
  // A record restored from storage can hold a grant for a purpose this tool no
  // longer presents. The gate still honours it, so "turn it all off" must
  // reach it — a live grant the user cannot see is the worst leftover.
  const storage = fakeStorage();
  const withOptIn = new ConsentManager({
    storage,
    purposes: ALL_PURPOSES.map((p) => p.id),
    retainErasureLog: false,
  });
  withOptIn.grant(PURPOSES.SHARE_DERIVED_METADATA.id, {
    noticeVersion: noticeVersion([PURPOSES.SHARE_DERIVED_METADATA]), explicit: true,
  });
  assert.equal(withOptIn.granted().length, 1);

  // The tool is reconfigured to present only the core four.
  const narrowed = new ConsentManager({ storage, retainErasureLog: false });
  assert.equal(narrowed.granted().length, 1, 'the grant is still live');
  assert.deepEqual(narrowed.snapshot().grantedButNotPresented, [PURPOSES.SHARE_DERIVED_METADATA.id]);

  narrowed.withdrawAll();
  assert.equal(narrowed.granted().length, 0, 'withdrawAll reached the hidden grant');
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

test('with no declaration the record says UNSTATED, not "none"', () => {
  // The earlier version hardcoded 'none — no transmission' here. That is a
  // claim about the HOST's behaviour, made by a library that cannot know it.
  // A host that later adds an online path would ship a machine-readable
  // "nothing transmitted" it never said. The honest default is silence.
  const consent = new ConsentManager();
  assert.deepEqual(consent.record.handling.recipients, []);
  assert.equal(consent.record.handling.stated, false);
  assert.match(consent.record.handling.recipientsDeclaration, /unstated/i);
  assert.equal(consent.record.handling.signal, null, 'nothing is asserted about signal');
});

test('a declaration makes the recipients field machine-readable', () => {
  const consent = new ConsentManager({
    declaration: {
      signal: SIGNAL_HANDLING.LOCAL_ONLY,
      derivedMetadata: DERIVED_METADATA_HANDLING.NONE,
      declaredBy: 'Example Tool',
    },
  });
  assert.equal(consent.record.handling.stated, true);
  assert.equal(consent.record.handling.storage, 'local-only');
  assert.deepEqual(consent.record.handling.recipients, []);
  assert.match(consent.record.handling.recipientsDeclaration, /declared none/i);
  assert.equal(consent.record.handling.declaredBy, 'Example Tool');
});

test('a host that shares derived metadata must name recipients', () => {
  // "shared, recipients: []" is not a weaker claim than a named list — it is
  // an unanswerable one, and it would render next to a consent screen as
  // reassurance. Refused outright.
  const incoherent = new ConsentManager({
    declaration: {
      signal: SIGNAL_HANDLING.LOCAL_ONLY,
      derivedMetadata: DERIVED_METADATA_HANDLING.SHARED,
      recipients: [],
    },
  });
  assert.equal(incoherent.declaration, null, 'an incoherent declaration is refused');
  assert.equal(incoherent.record.handling.stated, false);

  // Naming recipients while claiming nothing is shared is the same class of
  // contradiction, in the other direction.
  assert.equal(normalizeDeclaration({
    signal: SIGNAL_HANDLING.LOCAL_ONLY,
    derivedMetadata: DERIVED_METADATA_HANDLING.NONE,
    recipients: ['api.example.com'],
  }), null);

  // A complete one is accepted.
  const ok = normalizeDeclaration({
    signal: SIGNAL_HANDLING.LOCAL_ONLY,
    derivedMetadata: DERIVED_METADATA_HANDLING.SHARED,
    recipients: ['api.example.com'],
  });
  assert.ok(ok);
  assert.deepEqual([...ok.recipients], ['api.example.com']);
});

test('an unrecognised declaration value is refused, not passed through', () => {
  assert.equal(normalizeDeclaration({
    signal: 'probably-fine',
    derivedMetadata: DERIVED_METADATA_HANDLING.NONE,
  }), null, 'a value outside the vocabulary must not render as reassurance');
  assert.equal(normalizeDeclaration({ signal: SIGNAL_HANDLING.LOCAL_ONLY }), null,
    'a half-declaration is not a declaration');
  assert.equal(normalizeDeclaration(null), null);
});

test('declarationText states the ABSENCE when there is no declaration', () => {
  const text = declarationText(null);
  assert.match(text, /NOT DECLARED/);
  // The wording must not itself become an assurance.
  assert.ok(!/not transmitted/i.test(text), 'silence must not read as a promise');
});

test('changing the declaration is recorded as an event', () => {
  // A tool could otherwise revise its disclosure while leaving the evidence
  // untouched — the same shape as editing the record.
  const consent = new ConsentManager();
  const before = consent.record.events.length;
  consent.setDeclaration({
    signal: SIGNAL_HANDLING.LOCAL_ONLY,
    derivedMetadata: DERIVED_METADATA_HANDLING.SHARED,
    recipients: ['api.example.com'],
  });
  assert.ok(consent.record.events.length > before, 'the change is in the log');
  assert.equal(consent.record.verify().ok, true, 'and the chain still verifies');
  assert.throws(() => consent.setDeclaration({
    signal: SIGNAL_HANDLING.LOCAL_ONLY,
    derivedMetadata: DERIVED_METADATA_HANDLING.SHARED,
  }), /incomplete or contradictory/);
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
  assert.ok(text.includes('cannot tell you'), 'it must say what it cannot know');
});

test('CRITICAL: the disclaimer makes no claim about the HOST tool', () => {
  // The original `full` text ended with "Your signal is processed on this
  // device and is not transmitted ... you can verify it" under a heading
  // claiming truth. Every clause of that is true of THIS LIBRARY and none of
  // it is knowable about the tool embedding it — and the text renders inside
  // the host's UI. A host adding one optional online path would have this
  // library telling its users something false, in the host's own interface.
  const text = DISCLAIMER.full;
  const banned = [
    /your signal is processed on this device/i,
    /is not transmitted/i,
    /there is no server receiving it/i,
    /nobody to sell it to/i,
    /you can verify/i,
  ];
  for (const re of banned) {
    assert.ok(!re.test(text),
      `the library must not assert host behaviour: ${re}`);
  }
  // A library-scoped claim IS supported — and CI checks it holds.
  assert.ok(/no network code/i.test(text), 'it still states what is true of itself');
});

test('the rendered disclaimer carries the host declaration, not just the library text', () => {
  const consent = new ConsentManager();
  const rendered = consent.disclaimerText();
  assert.ok(rendered.includes('WHAT THIS TOOL DECLARES ABOUT ITSELF'));
  assert.match(rendered, /NOT DECLARED/, 'a tool that declared nothing says so on screen');
  assert.ok(rendered.startsWith(DISCLAIMER.full), 'the library text is the base');

  const declared = new ConsentManager({
    declaration: {
      signal: SIGNAL_HANDLING.LOCAL_ONLY,
      derivedMetadata: DERIVED_METADATA_HANDLING.NONE,
      declaredBy: 'Example Tool',
    },
  });
  assert.match(declared.disclaimerText(), /Example Tool/);
  assert.ok(!/NOT DECLARED/.test(declared.disclaimerText()));
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

test('notice version names each purpose the tool actually PRESENTS', () => {
  const v = noticeVersion();
  assert.equal(v, noticeVersion(), 'the version must be deterministic');
  for (const p of DEFAULT_PURPOSES) {
    assert.ok(v.includes(p.id), `the version names ${p.id}`);
  }
  // A tool with no online path must not stamp its notice version with the
  // opt-in purpose — the version records what the person was SHOWN.
  assert.ok(!v.includes(PURPOSES.SHARE_DERIVED_METADATA.id),
    'the default notice version excludes the opt-in purpose');

  const full = noticeVersion(ALL_PURPOSES);
  assert.ok(full.includes(PURPOSES.SHARE_DERIVED_METADATA.id),
    'a tool that presents it does name it');
});

test('the snapshot carries the disclaimer to whatever renders it', () => {
  const consent = new ConsentManager();
  const snap = consent.snapshot();
  assert.ok(snap.disclaimer, 'a UI cannot forget to include the disclaimer');
  assert.ok(snap.disclaimerText, 'and the renderable version with the declaration');
  assert.equal(snap.purposes.length, 4, 'the default tool presents four');
  assert.ok(snap.chain.ok);
  assert.equal(snap.consentEpoch, 0);
});

// -- the opt-in fifth purpose: share_derived_metadata ------------------------

const SHARE = PURPOSES.SHARE_DERIVED_METADATA.id;

test('the opt-in purpose is NOT in the default set', () => {
  // A local-first tool has no online path, and showing a permission for a
  // feature that does not exist is its own kind of dishonesty.
  const consent = new ConsentManager();
  assert.equal(consent.presents(SHARE), false);
  assert.equal(consent.snapshot().purposes.length, 4);
  assert.ok(!DEFAULT_PURPOSES.some((p) => p.id === SHARE));
  assert.ok(CORE_PURPOSES.every((p) => p.id !== SHARE));
});

test('CRITICAL: the opt-in purpose cannot be granted without { explicit: true }', () => {
  // Every plausible alternative lets the grant arrive with no person in the
  // loop: a host looping over manager.purposes, a config-file default, a
  // "grant all recommended" helper. Each is one line of ordinary code and
  // each would ship an online-feature permission nobody was asked about.
  const consent = new ConsentManager({ purposes: ALL_PURPOSES.map((p) => p.id) });
  assert.throws(
    () => consent.grant(SHARE, { noticeVersion: noticeVersion(ALL_PURPOSES) }),
    /requires an explicit grant/
  );
  assert.equal(consent.isGranted(SHARE), false, 'the failed grant took no effect');

  // A batch loop over every presented purpose still cannot carry it.
  let threw = false;
  try {
    for (const p of consent.purposes) consent.grant(p.id, { noticeVersion: noticeVersion() });
  } catch { threw = true; }
  assert.equal(threw, true, 'the batch loop hits the guard');
  assert.equal(consent.isGranted(SHARE), false);

  // The one legitimate path.
  consent.grant(SHARE, { noticeVersion: noticeVersion([PURPOSES.SHARE_DERIVED_METADATA]), explicit: true });
  assert.equal(consent.isGranted(SHARE), true);
});

test('CRITICAL: granting a core purpose never implies the opt-in one', () => {
  // Purpose limitation, in the direction that actually matters: agreeing that
  // a tool may read your signal on your device must not authorise sending
  // summaries off it.
  const consent = new ConsentManager({ purposes: ALL_PURPOSES.map((p) => p.id) });
  for (const p of CORE_PURPOSES) consent.grant(p.id, { noticeVersion: noticeVersion(ALL_PURPOSES) });
  assert.equal(consent.isGranted(SHARE), false,
    'acquire_signal must not carry share_derived_metadata');
  assert.equal(consent.isGranted(PURPOSES.ACQUIRE_SIGNAL.id), true);
});

test('CRITICAL: refusing the opt-in purpose is always allowed', () => {
  // The guard protects the dangerous direction only.
  const consent = new ConsentManager({ purposes: ALL_PURPOSES.map((p) => p.id) });
  consent.refuse(SHARE, { noticeVersion: noticeVersion(ALL_PURPOSES) });
  assert.equal(consent.stateOf(SHARE), 'refused');
});

test('reaffirming the opt-in purpose also needs the explicit flag', () => {
  const consent = new ConsentManager({ purposes: ALL_PURPOSES.map((p) => p.id) });
  consent.grant(SHARE, { noticeVersion: noticeVersion([PURPOSES.SHARE_DERIVED_METADATA]), explicit: true });
  assert.throws(() => consent.reaffirm(SHARE), /requires an explicit grant/);
  // Both halves are required on reaffirm too — a flag alone is context-free.
  assert.throws(
    () => consent.reaffirm(SHARE, { explicit: true }),
    /notice version of its own text/,
    'the flag without this purpose\'s own notice version must not pass'
  );
  consent.reaffirm(SHARE, {
    explicit: true,
    noticeVersion: noticeVersion([PURPOSES.SHARE_DERIVED_METADATA]),
  });
  assert.equal(consent.isGranted(SHARE), true);
});

test('CRITICAL: a batch loop passing { explicit: true } still cannot carry the opt-in', () => {
  // This is the case the flag alone did not cover. `explicit: true` is
  // context-free — the same token grants anything — so a host writing
  //   for (const p of purposes) grant(p.id, { explicit: true, noticeVersion })
  // would carry the opt-in purpose along with the four core permissions. That
  // loop is one line of ordinary code.
  //
  // Requiring the SINGLE-purpose notice version makes it fail: the value a
  // panel computes covers several purposes, and this purpose accepts only its
  // own. A caller cannot produce the right string by accident.
  const consent = new ConsentManager({ purposes: ALL_PURPOSES.map((p) => p.id) });
  const panelVersion = noticeVersion(ALL_PURPOSES); // what a real UI would compute

  assert.throws(
    () => consent.grant(SHARE, { explicit: true, noticeVersion: panelVersion }),
    /notice version of its own text/,
    'the panel-wide version must not authorise a single opt-in purpose'
  );
  assert.equal(consent.isGranted(SHARE), false, 'and nothing was granted');

  // The core four are unaffected by the panel version.
  for (const p of CORE_PURPOSES) {
    consent.grant(p.id, { noticeVersion: panelVersion });
  }
  assert.equal(consent.granted().length, 4);

  // The one legitimate call names this purpose's own notice.
  const ownVersion = noticeVersion([PURPOSES.SHARE_DERIVED_METADATA]);
  assert.notEqual(ownVersion, panelVersion, 'the two versions must differ');
  consent.grant(SHARE, { explicit: true, noticeVersion: ownVersion });
  assert.equal(consent.isGranted(SHARE), true);
});

test('the opt-in purpose withdrawal is immediate like any other', () => {
  const consent = new ConsentManager({ purposes: ALL_PURPOSES.map((p) => p.id) });
  consent.grant(SHARE, { noticeVersion: noticeVersion([PURPOSES.SHARE_DERIVED_METADATA]), explicit: true });
  consent.withdraw(SHARE);
  assert.equal(consent.isGranted(SHARE), false);
  assert.throws(() => consent.require(SHARE), ConsentRequiredError);
});

// -- erasure evidence --------------------------------------------------------

test('CRITICAL: erase keeps a hash-only tombstone, not a clean slate', () => {
  // The bug: erase() deleted the record and emitted an in-memory event to
  // listeners, then the record it described was gone from storage. The next
  // load was indistinguishable from a user who never consented — so the
  // strongest protective action destroyed the evidence the withdrawal
  // happened. A user asking "prove I withdrew before you used my data" was
  // worse off after erasing than before.
  const storage = fakeStorage();
  const consent = new ConsentManager({ storage });
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  consent.withdraw(ACQ);
  const chainHead = consent.record.events[consent.record.events.length - 1].hash;

  consent.erase();

  const tombstone = JSON.parse(storage.getItem('neural-consent.record.erased'));
  assert.ok(tombstone, 'the erasure leaves a record of itself');
  assert.equal(tombstone.withdrawalCount, 1, 'it records that a withdrawal happened');
  assert.equal(tombstone.chainHead, chainHead, 'and the chain head it erased');
  assert.equal(tombstone.containsPersonalData, false);

  // And it cannot reconstruct what the user did.
  const serialised = JSON.stringify(tombstone);
  assert.ok(!/acquire_signal|dwell|settings|eeg|signal/i.test(serialised),
    'the tombstone carries no purpose, timing, or signal detail');
  assert.ok(!tombstone.purposes, 'no purposes block');
  assert.ok(!tombstone.events, 'no event log');
});

test('the tombstone survives a reload and is readable as erasure evidence', () => {
  const storage = fakeStorage();
  const first = new ConsentManager({ storage });
  first.grant(ACQ, { noticeVersion: noticeVersion() });
  first.erase();

  const second = new ConsentManager({ storage });
  assert.equal(second.granted().length, 0, 'the erasure held');
  const info = second.erasureInfo();
  assert.ok(info, 'and the evidence is still there');
  assert.equal(info.reason, 'user request');
});

test('erase can be told to leave no tombstone at all', () => {
  const storage = fakeStorage();
  const consent = new ConsentManager({ storage });
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  consent.erase({ keepTombstone: false });
  assert.equal(storage.getItem('neural-consent.record.erased'), null);
  assert.equal(consent.erasureInfo(), null);
});

test('erasing twice does not stack tombstones', () => {
  const storage = fakeStorage();
  const consent = new ConsentManager({ storage });
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  consent.erase();
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  consent.erase();
  const tombstone = JSON.parse(storage.getItem('neural-consent.record.erased'));
  assert.equal(tombstone.withdrawalCount, 0, 'the second record had no withdrawals');
});

// -- revocation reach --------------------------------------------------------

test('consentEpoch counts withdrawals and is DERIVED from the log', () => {
  const consent = new ConsentManager();
  assert.equal(consent.record.consentEpoch, 0);
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  assert.equal(consent.record.consentEpoch, 0, 'a grant is not a revocation');
  consent.withdraw(ACQ);
  assert.equal(consent.record.consentEpoch, 1);
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  consent.withdraw(ACQ);
  assert.equal(consent.record.consentEpoch, 2);

  // Derived, not stored: an edited copy cannot disagree with the log.
  assert.equal(consent.record.toJSON().consentEpoch, undefined,
    'the epoch is not serialised — one source of truth');
  const restored = ConsentRecord.fromJSON(consent.record.toJSON());
  assert.equal(restored.consentEpoch, 2, 'it re-derives from the restored events');
});

test('revocationState is what a host sends so a service can detect staleness', () => {
  const consent = new ConsentManager();
  consent.grant(ACQ, { noticeVersion: noticeVersion() });
  consent.withdraw(ACQ);
  const rev = consent.record.revocationState();
  assert.equal(rev.epoch, 1);
  assert.ok(rev.recordId, 'a service can correlate on the local pseudonymous id');
  assert.deepEqual(rev.granted, [], 'and sees the current grant set');
  assert.ok(rev.at, 'with a timestamp');
  // It is a hint, not a credential.
  assert.ok(!/token|secret|signature|jwt/i.test(JSON.stringify(rev)),
    'the revocation state carries no authorization material');
});

// -- integrity reporting -----------------------------------------------------

test('CRITICAL: chainIntact and stateMatchesChain are reported separately', () => {
  // verify().ok is false for two different reasons, and reporting both under
  // the name `chainIntact` told a reader the log had been tampered with when
  // it had not. An instrument that misnames which of two things went wrong
  // sends the investigation the wrong way.
  const rec = new ConsentRecord({ now: () => 1000 });
  rec.decide('acquire_signal', 'given', { noticeVersion: 'v1' });
  rec.purposes.acquire_signal.state = 'withdrawn'; // edit behind the log

  const summary = rec.summary();
  assert.equal(summary.chainIntact, true, 'the LOG is untouched and says so');
  assert.equal(summary.stateMatchesChain, false, 'the STATE was rewritten');
  assert.equal(summary.brokenAt, -1);
  assert.equal(rec.verify().ok, false, 'the combined answer is still false');

  // And the genuine break reports the other way round.
  const broken = new ConsentRecord({ now: () => 1000 });
  broken.decide('acquire_signal', 'given', { noticeVersion: 'v1' });
  broken.events[0].type = 'forged';
  assert.equal(broken.summary().chainIntact, false);
  assert.equal(broken.summary().brokenAt, 0);
});

test('a stale stored declaration cannot be restored over the current one', () => {
  // The record serialises its declaration. If a host has since added an online
  // path, restoring the file's copy would put a reassuring "nothing
  // transmitted" back after the fact. The caller's declaration wins.
  const storage = fakeStorage();
  const localOnly = {
    signal: SIGNAL_HANDLING.LOCAL_ONLY,
    derivedMetadata: DERIVED_METADATA_HANDLING.NONE,
  };
  const first = new ConsentManager({ storage, declaration: localOnly });
  first.grant(ACQ, { noticeVersion: noticeVersion() });
  assert.equal(first.record.handling.stated, true);

  // The tool has since added an online feature.
  const second = new ConsentManager({
    storage,
    declaration: {
      signal: SIGNAL_HANDLING.LOCAL_ONLY,
      derivedMetadata: DERIVED_METADATA_HANDLING.SHARED,
      recipients: ['api.example.com'],
    },
  });
  assert.equal(second.record.handling.derivedMetadata, 'shared');
  assert.deepEqual(second.record.handling.recipients, ['api.example.com'],
    'the CURRENT declaration is what the record carries');
  assert.equal(second.isGranted(ACQ), true, 'and the grant itself still restores');
});

test('a stored handling block is never trusted verbatim', () => {
  // Belt and braces: even a file that carries a hand-written "no transmission"
  // handling block gets it replaced by the derived value.
  const storage = fakeStorage();
  const first = new ConsentManager({ storage });
  first.grant(ACQ, { noticeVersion: noticeVersion() });
  const data = JSON.parse(storage.getItem('neural-consent.record'));
  data.handling = { recipients: [], recipientsDeclaration: 'none — no transmission', stated: true };
  storage.setItem('neural-consent.record', JSON.stringify(data));

  const second = new ConsentManager({ storage });
  assert.equal(second.record.handling.stated, false,
    'the injected claim is discarded, not restored');
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
