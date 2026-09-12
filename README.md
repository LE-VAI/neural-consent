# neural-consent

**Purpose-granular consent records with a tamper-evident local event log** for tools that read a neural or assistive signal on the user's own device. Zero dependencies. Runs in the browser and in Node.

```bash
npm install neural-consent
```

```js
import { ConsentManager, PURPOSES, DISCLAIMER } from 'neural-consent';

const consent = new ConsentManager({ storage: localStorage });

// The gate. Processing must not happen without this passing.
if (consent.isGranted(PURPOSES.ACQUIRE_SIGNAL.id)) {
  startReadingSignal();
}
```

---

## What this is not

**This is not a compliance solution, and it does not claim to be one.** That sentence is the most important one in this README.

Whether a privacy statute applies to a given tool depends on facts about whoever *publishes* it — their revenue, how many people use it, and where those people live — not on what the code does. A consent screen cannot change that. The shipped `DISCLAIMER` says so in the words the tool should show its users, and a test asserts that it never contains the phrases *"CCPA compliant"*, *"GDPR compliant"*, *"HIPAA compliant"*, *"FDA cleared"*, *"certified"*, or *"privacy-compliant by architecture"*.

A comparable project markets itself as "privacy-compliant by architecture — not by policy." No library can make that claim. Architecture is evidence; compliance is a legal conclusion that depends on facts outside the code.

## The thing that is actually true

A tool that never transmits the signal **has no third party to share it with, nothing to sell, and no database to breach.** That is a verifiable statement about the software — you can open your browser's network panel and watch that nothing leaves.

This module records that as a machine-readable field rather than a promise:

```js
record.handling = {
  storage: 'local-only',
  recipients: [],
  recipientsDeclaration: 'none — no transmission',
}
```

## The gate actually gates

A consent screen that records a decision but does not prevent processing is documentation, not consent. So the API is shaped as a gate, and `require()` **throws** rather than returning a falsy value — a silently-skipped permission check is how consent gets bypassed by accident:

```js
consent.require(PURPOSES.PROCESS_LOCALLY.id); // throws ConsentRequiredError
```

## Purposes are separate

Granularity is deliberate. Both ISO/IEC TS 27560 and the state laws require **purpose limitation**: consent to one thing must not silently authorise another. There is no bundled "I agree."

| Purpose | What it covers |
|---|---|
| `acquire_signal` | reading the switch / gaze / EEG signal |
| `process_locally` | processing it on the device |
| `persist_locally` | remembering settings between sessions |
| `export` | the user saving their own data to a file |

There is deliberately no *analytics* or *improve our services* purpose — including a purpose you do not use is its own kind of dishonesty.

## Withdrawal is immediate and symmetric

```js
consent.withdraw(PURPOSES.ACQUIRE_SIGNAL.id); // takes effect now
consent.withdrawAll();                        // the "turn it all off" path
consent.isGranted(id);                        // false
```

Withdrawal is recorded as an event, not as an amendment. Consent also **lapses**: grants carry a validity window, and a stale record is expired on load rather than silently remaining valid. `reaffirm()` renews deliberately.

## The event log is tamper-evident, not tamper-proof

Each event carries the hash of the previous one, so altering or removing a past entry breaks the chain and `verify()` reports where:

```js
const { ok, brokenAt } = record.verify();
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
