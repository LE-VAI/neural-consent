/**
 * neural-consent — local-first consent mechanics for neural-data tools.
 *
 * WHAT THIS IS. A purpose-granular consent record with a tamper-evident local
 * event log, structured on the ISO/IEC TS 27560 field model, for tools that
 * read a neural or assistive signal on the user's own device.
 *
 * WHAT THIS IS NOT. It is not a compliance solution, and it does not claim to
 * be one. Whether a privacy statute applies to a given tool depends on facts
 * about whoever publishes it — revenue, consumer counts, jurisdictions — not
 * on what the code does. A consent screen cannot change that. The DISCLAIMER
 * export states this in the words the tool should show.
 *
 * THE LINE THIS MODULE DRAWS. It speaks for itself and not for the tool around
 * it. Two facts about the library are checkable and CI checks them: it has no
 * network code, and its event log is hash-chained. What the EMBEDDING TOOL does
 * with a signal is a different question that this library cannot answer — so it
 * does not answer it, and shows the tool's own declaration instead. An earlier
 * version asserted "your signal is not transmitted" in text rendered inside the
 * host's UI; that was a claim about code the library does not control, and a
 * host adding one optional online path would have made it false. See
 * notices.js.
 *
 * ONE OPT-IN PURPOSE. Tools that read locally but offer an optional online
 * feature can present `share_derived_metadata`. It is excluded from the default
 * set, cannot be bundled with any other purpose, and its grant throws unless
 * the caller passes `{ explicit: true }`.
 */

export {
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
  purposeById,
  resolvePurposes,
  normalizeDeclaration,
  declarationText,
  disclaimerText,
  keyInformationText,
} from './consent.js';

export {
  ConsentRecord,
  SCHEMA_VERSION,
  STATES,
  generateId,
  fnv1a,
} from './record.js';
