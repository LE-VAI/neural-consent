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
 * The honest position this module is built on: a tool that never transmits
 * the signal has no third party to share with, nothing to sell, and no
 * database to breach. That is a verifiable statement about the software. The
 * record states it as a machine-readable field rather than as a promise.
 */

export {
  ConsentManager,
  ConsentRequiredError,
  PURPOSES,
  DISCLAIMER,
  noticeVersion,
  purposeById,
} from './consent.js';

export {
  ConsentRecord,
  SCHEMA_VERSION,
  STATES,
  generateId,
  fnv1a,
} from './record.js';

export { keyInformationText } from './notices.js';
