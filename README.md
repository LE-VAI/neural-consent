# neural-consent

**Purpose-granular consent records with a tamper-evident local event log** for tools that read a neural or assistive signal on the user's own device. Zero dependencies. Runs in the browser and in Node.

```bash
npm install neural-consent
```

**[Try the live consent demo →](https://le-vai.github.io/neural-consent/demo/)**

```js
import { ConsentManager, PURPOSES, DISCLAIMER } from 'neural-consent';

const consent = new ConsentManager({ storage: localStorage });

// The gate. Processing must not happen without this passing.
if (consent.isGranted(PURPOSES.ACQUIRE_SIGNAL.id)) {
  startReadingSignal();
}
```

---

## Two rules this library holds itself to

**1. It speaks for itself, and not for the tool around it.** It can state facts about its own code, and CI checks the one it states — no network API appears anywhere in `src/`. What the *embedding tool* does with a signal is a different question, and this library is not in a position to answer it. So it doesn't. Recipient fields and the user-facing disclaimer are both built from a declaration the host supplies, or report the handling as **unstated**. An earlier version asserted *"your signal is not transmitted"* in text rendered inside the host's UI — a claim about code it does not control, which one optional cloud feature would have made false.

**2. Erasure leaves evidence of itself.** Deleting the record also deleted the proof that a withdrawal had happened. `erase()` now keeps a hash-only tombstone: that a record existed and was deliberately ended, and nothing about what it contained.

## What this is not

**This is not a compliance solution, and it does not claim to be one.** That sentence is the most important one in this README.

Whether a privacy statute applies to a given tool depends on facts about whoever *publishes* it — their revenue, how many people use it, and where those people live — not on what the code does. A consent screen cannot change that. The shipped `DISCLAIMER` says so in the words the tool should show its users, and a test asserts that it never contains the phrases *"CCPA compliant"*, *"GDPR compliant"*, *"HIPAA compliant"*, *"FDA cleared"*, *"certified"*, or *"privacy-compliant by architecture"*.

A comparable project markets itself as "privacy-compliant by architecture — not by policy." No library can make that claim. Architecture is evidence; compliance is a legal conclusion that depends on facts outside the code.

## What is actually true — and who gets to say it

A tool that never transmits the signal **has no third party to share it with, nothing to sell, and no database to breach.** That is a verifiable statement about the software.

But this library is not the tool. It is a layer inside someone else's tool, and it has no way to observe what that tool does with a signal or whether it adds an online path next month. An earlier version of this module blurred that line, and the blur had teeth:

- The **disclaimer text** — which renders inside the host's own interface — ended with a section headed "WHAT IS ACTUALLY TRUE" claiming *"your signal is processed on this device and is not transmitted… you can verify it."* Every clause is true of this library and none of it is knowable about the host. A tool adding one optional cloud feature would have had this library telling its users something false, in that tool's own UI, under a heading that claimed truth.
- The **record's recipient fields** were similarly hardcoded to `recipients: []` / `'none — no transmission'`. A host that later added an online path would have shipped a machine-readable declaration saying nothing is transmitted, produced by this library, on the host's behalf, without the host ever saying so.

So both are now built from a **declaration the host supplies**, and report the handling as *unstated* when there is none:

```js
const consent = new ConsentManager({
  declaration: {
    signal: SIGNAL_HANDLING.LOCAL_ONLY,
    derivedMetadata: DERIVED_METADATA_HANDLING.NONE,
    declaredBy: 'Example Tool',
  },
});

consent.record.handling = {
  storage: 'local-only',
  stated: true,
  recipients: [],
  recipientsDeclaration: 'declared none — no derived metadata transmitted',
  declaredBy: 'Example Tool',
  ...
}
```

With no declaration, `stated: false` and the text says **NOT DECLARED** — in the same weight a declaration would occupy, because an omitted section reads as "nothing to worry about," which is an assurance nobody gave. A reader (or a downstream system) can always tell a declaration from a silence. An incoherent one is refused outright: a tool that says it shares derived data but names no recipient is not making a weaker claim than a named list, it is making an unanswerable one.

What the library *can* claim about itself, it does, and CI enforces the claim: `scripts/audit-no-network.py` fails the build if any network API or endpoint appears in `src/`. That is the check behind the sentence *"the consent layer you are reading has no network code."*

## The gate actually gates

A consent screen that records a decision but does not prevent processing is documentation, not consent. So the API is shaped as a gate, and `require()` **throws** rather than returning a falsy value — a silently-skipped permission check is how consent gets bypassed by accident:

```js
consent.require(PURPOSES.PROCESS_LOCALLY.id); // throws ConsentRequiredError
```

## Purposes are separate

Granularity is deliberate. Both ISO/IEC TS 27560 and the state laws require **purpose limitation**: consent to one thing must not silently authorise another. There is no bundled "I agree."

| Purpose | What it covers | Present by default |
|---|---|---|
| `acquire_signal` | reading the switch / gaze / EEG signal | yes |
| `process_locally` | processing it on the device | yes |
| `persist_locally` | remembering settings between sessions | yes |
| `export` | the user saving their own data to a file | yes |
| `share_derived_metadata` | short summaries sent to an optional online service | **no — opt-in only** |

There is deliberately no *analytics* or *improve our services* purpose — including a purpose you do not use is its own kind of dishonesty. That rule is why the fifth purpose is opt-in rather than always present: a tool with no online path must never show a permission for a feature it does not have.

### The opt-in purpose

A growing class of neural-data tool runs locally on the signal and offers an *optional* online feature on top — an assistant you can query, a report generator, settings sync. Those features must send something, and the something is small: which control was used, how long a session ran, the settings in play. The raw signal stays local.

Both alternatives are worse. Folding it into `acquire_signal` would mean agreeing to read a signal on your device also ships metadata to a server — the exact bundling purpose limitation forbids. Refusing to record it would push tools into inventing their own consent vocabulary beside this one.

```js
const consent = new ConsentManager({
  purposes: [...DEFAULT_PURPOSES.map(p => p.id), 'share_derived_metadata'],
});

consent.grant('share_derived_metadata', { ... });
// ✗ throws: requires an explicit grant

consent.grant('share_derived_metadata', { noticeVersion, explicit: true });
// ✓ the only path
```

The `{ explicit: true }` flag is not ceremony. Every plausible alternative lets the grant arrive with nobody in the loop — a host looping over `manager.purposes`, a config-file default, a future "grant all recommended" helper. Each is one line of ordinary code, and each would ship an online-feature permission nobody was asked about. Requiring the literal flag means the one line that grants it is a line someone had to write and read.

## Withdrawal is immediate and symmetric

```js
consent.withdraw(PURPOSES.ACQUIRE_SIGNAL.id); // takes effect now
consent.withdrawAll();                        // the "turn it all off" path
consent.isGranted(id);                        // false
```

Withdrawal is recorded as an event, not as an amendment. Consent also **lapses**: grants carry a validity window, and a stale record is expired on load rather than silently remaining valid. `reaffirm()` renews deliberately.

`withdrawAll()` reaches **every** live grant, including one restored from storage for a purpose the current screen no longer presents. The gate honours such a grant, so "turn it all off" has to mean all of it — a live grant the user cannot see is the worst kind of leftover. `snapshot().grantedButNotPresented` surfaces any that exist.

### Revocation has no reach on its own — so the request carries it

A record lives in the user's browser. A service that received derived metadata last week has no way to learn that consent was revoked yesterday, and silence is indistinguishable from "still granted." This library cannot close that gap — honouring a revocation is the service's job and no client-side code can compel it — but it can make closing it possible:

```js
record.revocationState();
// { recordId: '...', epoch: 2, granted: [...], at: '...' }
```

`epoch` counts withdrawals in the record's history and is **derived from the hash-chained log**, never stored — a counter field would be one more thing that can fall out of step, and this is the worst field to have drift, because it is the one a remote service is asked to trust. `epoch: 3` against a service's cached `epoch: 1` means two withdrawals happened since, so the cached grant is stale.

It is a staleness hint, not an authorization credential: it contains no secret and proves nothing.

## Erasure leaves evidence of itself

`erase()` used to delete the record and emit an in-memory event to listeners. The record that event described was already gone from storage, so the next load was indistinguishable from a user who had never consented — the strongest, most protective action a person can take destroyed the very evidence that the withdrawal happened. Someone whose concern is *"prove I withdrew before you used my data"* was worse off after erasing than before.

```js
consent.erase();
// → keeps a hash-only tombstone under `${storageKey}.erased`

{
  recordId: '...', erasedAt: '...', withdrawalCount: 1,
  eventCount: 2, chainHead: 'a3f1...',
  containsPersonalData: false,
  note: 'Hash-only tombstone. Records that a consent record was erased, not what it contained.'
}
```

No purposes, no timings, no signal metadata, no settings — it cannot reconstruct what the user did, only that this record existed and was deliberately ended. Erasure is a real right, and a library that quietly keeps a full copy to serve the second user would be violating the first. `erase({ keepTombstone: false })` leaves no trace at all.

## The event log is tamper-evident, not tamper-proof

Each event carries the hash of the previous one, so altering or removing a past entry breaks the chain and `verify()` reports where:

```js
const { ok, brokenAt, stateMismatch } = record.verify();
```

The library also reports two distinct facts about its own integrity, because reporting them as one was misleading. A record whose `purposes` were edited behind an untouched log has an **intact chain** and a **state mismatch** — an earlier `summary()` reported that as `chainIntact: false`, telling a reader the log had been tampered with when it had not. An instrument that misnames which of two things went wrong sends the investigation the wrong way:

```js
const { chainIntact, stateMatchesChain } = record.summary();
```

**Be clear about what this does and does not do.** Anyone with access to their own device can rewrite the whole file — that is inherent to local-first storage and pretending otherwise would be a lie. The chain's job is to make *accidental or partial* modification detectable, and to give a user a way to check their own record was not quietly changed by the tool.

The hash is FNV-1a (32-bit), not a cryptographic digest, because this runs in a browser with zero dependencies and WebCrypto's digest is async. 32 bits is the right size for detecting accidental modification. It is not a security hash.

## Structured per ISO/IEC TS 27560 — with documented departures

The field set follows ISO/IEC TS 27560:2023's consent record model (mandatory fields are public via the W3C Data Privacy Vocabularies and Controls CG guide, published 2026-02-15).

Two deliberate departures, both recorded in the output rather than silently omitted:

```js
handling.omittedFields = ['pii_controller_address', 'jurisdiction', 'authority_party']
```

Those 27560 fields exist to let one organisation's consent records be read by another. A local-first tool exchanges nothing with anyone, so carrying a controller address would be theatre. A reviewer can see the decision instead of guessing at an absence.

Kept, because they earn their place: schema version, record id, subject id, the **notice version actually shown**, language, purpose, data types, a `neural` sensitivity flag, grant time, validity duration, the named withdrawal path, and the full event log.

## Accessibility is a requirement, not a nicety

This module serves tools built *for* disabled users. A consent flow that a screen-reader user cannot operate is self-refuting, so the demo is keyboard-operable with labelled controls and plain-language text. The notice model is layered — a concise key-information panel first, full detail available behind it — which is both the Common Rule's explicit model (45 CFR 46.116(a)(5)(i)) and what accessibility practice wants: a user should hear five lines before deciding, not a wall of text.

## Demo

```bash
python -m http.server 8796
# open http://127.0.0.1:8796/demo/
```

## Tests

```bash
npm test
```

28 tests, zero dependencies, `node:test`. The clock is injected everywhere, so validity-window and expiry behaviour is deterministic.

## What the research says about applicability

Verified against primary sources (September 2026):

- **Colorado HB24-1058** — in force 2024-08-07; adds neural data to the CPA's sensitive-data category requiring **opt-in** consent. Its "biological data" trigger only bites when the data is used for **identification**, which FPF notes "significantly narrow[s]" its scope for ordinary neural data.
- **California SB 1223** — operative 2025-01-01; neural data is sensitive personal information, giving a right to limit use.
- **Connecticut PA 25-113** (in force 2026-07-01) — note the sensitive-data trigger has **no consumer-count minimum**.
- **Vermont S.71** (signed 2026-06-16, effective 2028-01-01) — third threshold regime, 3,000 consumers' sensitive data.
- **Washington's My Health My Data Act** — **no thresholds at all, and a private right of action.** This is the jurisdiction where an overclaimed privacy policy creates the most exposure.
- **No federal neural-data statute.** The MIND Act (S.2925) would only direct an FTC study and has not advanced. FTC Act Section 5 remains the live federal instrument — which is precisely why *claims* matter, whether or not a privacy statute applies.

**No statute addresses on-device-only processing.** The argument that a tool which never receives data does not "collect" or "process" it is an interpretation, not settled law. This module is built so that the interpretation is at least easy to defend — and never asserted as established.

## License

MIT.
