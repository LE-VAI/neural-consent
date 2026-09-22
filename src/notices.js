/**
 * notices.js — consent notice text and the layered presentation model.
 *
 * WHAT THIS FILE IS FOR. Consent is only meaningful if the person actually
 * understood what they agreed to. The legal basis for presenting it in layers
 * is 45 CFR 46.116(a)(5)(i) (the Common Rule — the most rigorous consent model
 * in US law): consent "must begin with a concise and focused presentation of
 * the key information." That is a regulation explicitly asking for a
 * short-form-first design, which is also what accessibility practice wants:
 * a screen-reader user should hear five lines, not a wall.
 *
 * So every purpose carries TWO texts:
 *   - keyText:    the concise, focused version, shown first
 *   - detailText: the full explanation, available on request
 *
 * Both are versioned. The version that was SHOWN is recorded in the consent
 * record, because "what did the user actually agree to" is an evidentiary
 * question and the answer must be reconstructable.
 *
 * TONE. The text here is written for the person, not for a lawyer. It states
 * what happens, in plain words, at a reading level appropriate to someone
 * using an assistive tool — many of whom are disabled, tired, or in a hurry.
 * It does not use "we may" constructions that hide who does what.
 *
 * WHO MAY ASSERT WHAT. There is a line running through this file, and it is
 * the reason several things are phrased the way they are:
 *
 *   This library may speak for itself. It may not speak for the tool
 *   embedding it.
 *
 * The library knows exactly what its own code does (it transmits nothing, and
 * `scripts/audit-no-network.py` fails CI if that ever stops being true). It
 * knows nothing about the application around it, which may add an optional
 * online path tomorrow. So every statement of fact here is scoped to the
 * library, and anything about the surrounding tool is rendered from a
 * DECLARATION the tool itself supplies — or reported as absent. The earlier
 * version of this file asserted, in text displayed to the user, that "you can
 * verify" the signal is never transmitted. That was a claim about the host,
 * made on the host's behalf, in the host's UI. See declarationText() below.
 */

/**
 * The purposes this module can record consent for.
 *
 * Granularity is deliberate and minimal. ISO/IEC TS 27560 and the state laws
 * both require PURPOSE LIMITATION: consent to one thing must not silently
 * authorise another. A blanket "I agree" fails that, so each purpose is
 * separate and separate consent is required for each.
 *
 * There is no "analytics" and no "improve our services" purpose. Including a
 * purpose you do not use is its own kind of dishonesty, so a tool presents
 * only the purposes it actually has. That is why SHARE_DERIVED_METADATA is
 * flagged `requiresExplicitGrant` and is NOT in the default set: a tool with
 * no online path must never show it, and a tool that has one must ask for it
 * on its own.
 */
export const PURPOSES = {
  ACQUIRE_SIGNAL: {
    id: 'acquire_signal',
    version: '1.0.0',
    label: 'Read my input signal',
    keyText:
      'The tool reads the signal you connect — a switch, a gaze tracker, or an ' +
      'EEG sensor — to know what you are pointing at. This happens on your ' +
      'device, while the tool is open.',
    detailText:
      'Your device captures a signal from whatever input you connect. The tool ' +
      'uses it to decide which item on screen you mean, using the dwell and ' +
      'scan timings you set. Nothing about this signal is sent anywhere. ' +
      'Closing the tool stops the reading.',
  },
  PROCESS_LOCALLY: {
    id: 'process_locally',
    version: '1.0.0',
    label: 'Process it on this device',
    keyText:
      'Your signal is processed in this browser. It is not sent to a server, ' +
      'and no copy leaves this device.',
    detailText:
      'All processing — filtering, timing, deciding when a selection happens — ' +
      'runs in this browser tab. There is no backend that receives your data. ' +
      'This is verifiable: you can open your browser\u2019s network panel and ' +
      'watch that nothing is transmitted.',
  },
  PERSIST_LOCALLY: {
    id: 'persist_locally',
    version: '1.0.0',
    label: 'Remember my settings',
    keyText:
      'Your settings — dwell time, scan speed, and which input you use — are ' +
      'saved on this device so you do not have to set them again.',
    detailText:
      'Settings are stored in this browser\u2019s local storage. They stay on ' +
      'this device. Clearing your browser data removes them. No settings ' +
      'history is kept beyond your current choices.',
  },
  EXPORT: {
    id: 'export',
    version: '1.0.0',
    label: 'Let me export my own data',
    keyText:
      'You can save a copy of your own settings and consent record to a file, ' +
      'so you can move it to another device or send it to someone you choose.',
    detailText:
      'Export produces a file on your device containing your settings and this ' +
      'consent record. The tool does not send it anywhere \u2014 you decide what ' +
      'to do with the file. This exists so your data is portable to you, ' +
      'which is a right under several state privacy laws.',
  },

  /**
   * The optional fifth purpose: derived metadata to a service the tool offers.
   *
   * WHY THIS EXISTS AS A SEPARATE PURPOSE. A growing class of neural-data tool
   * runs locally on the signal and offers an OPTIONAL online feature on top —
   * an assistant you can query, a report generator, a settings sync. Those
   * features must send something, and the something is small: which control
   * was used, how long a session ran, the settings in play. The raw signal
   * stays local.
   *
   * The alternative designs are both worse. Folding it into `acquire_signal`
   * would mean agreeing to read a signal on your device also ships metadata to
   * a server — the exact bundling purpose limitation forbids. Refusing to
   * record it at all would push the tool into inventing its own consent
   * vocabulary beside this one, which is how a shared model fragments.
   *
   * `requiresExplicitGrant` is load-bearing, not decorative. A UI that offers
   * "agree to all", a host that pre-grants from a config file, or any future
   * code path that grants a set — none of them may carry this purpose.
   * ConsentManager.grant() throws if it is passed `implied`, and the manager
   * will not present this purpose unless the host explicitly includes it.
   */
  SHARE_DERIVED_METADATA: {
    id: 'share_derived_metadata',
    version: '1.0.0',
    requiresExplicitGrant: true,
    label: 'Send summaries to an online service',
    keyText:
      'Off unless you turn it on. If you do, this tool can send short ' +
      'summaries to an online service it offers \u2014 things like which ' +
      'control you used, how long a session ran, or which settings are ' +
      'active. Your raw signal, and anything you read or type, is not sent. ' +
      'Nothing works differently if you leave it off except the online ' +
      'features.',
    detailText:
      'Some tools run entirely on your device and still offer an optional ' +
      'online feature: an assistant you can ask questions, a report you can ' +
      'generate, a way to carry settings between devices. Those features need ' +
      'to send something, and this permission covers only the smallest thing ' +
      'that makes them work.\n\n' +
      'WHAT IS SENT: derived values the tool lists when it asks \u2014 not your ' +
      'signal. Which values those are is the tool\u2019s to state, and this ' +
      'library cannot know them; if the tool does not tell you, ask before ' +
      'turning this on.\n\n' +
      'WHAT IS NOT SENT: the raw signal from your switch, gaze tracker, or EEG ' +
      'sensor. No audio, no text you read, no text you type.\n\n' +
      'WHY IT IS SEPARATE: agreeing that a tool may read your signal on your ' +
      'device is a different decision from agreeing that it may send a summary ' +
      'off it. Purpose limitation requires them to be separate, so agreeing to ' +
      'one never agrees to the other.\n\n' +
      'TURNING IT OFF: withdrawal is immediate, and the online features stop. ' +
      'Everything that ran on your device keeps working.',
  },
};

/** The four purposes a local-first tool actually has. */
export const CORE_PURPOSES = [
  PURPOSES.ACQUIRE_SIGNAL,
  PURPOSES.PROCESS_LOCALLY,
  PURPOSES.PERSIST_LOCALLY,
  PURPOSES.EXPORT,
];

/** What a tool presents when it has no online path — the common case. */
export const DEFAULT_PURPOSES = CORE_PURPOSES;

/** Every purpose this module knows, including the opt-in one. */
export const ALL_PURPOSES = [...CORE_PURPOSES, PURPOSES.SHARE_DERIVED_METADATA];

/**
 * How a tool says what it does with the signal, and who receives derived
 * metadata. The vocabulary is closed: an unlisted value is refused rather than
 * passed through, because an unrecognised declaration rendered next to a
 * consent screen reads as reassurance whether or not it is one.
 */
export const SIGNAL_HANDLING = {
  LOCAL_ONLY: 'local-only',
  TRANSMITTED: 'transmitted',
};

export const DERIVED_METADATA_HANDLING = {
  NONE: 'none',
  SHARED: 'shared',
};

const SIGNAL_VALUES = new Set(Object.values(SIGNAL_HANDLING));
const DERIVED_VALUES = new Set(Object.values(DERIVED_METADATA_HANDLING));

/**
 * Validate and freeze a host declaration.
 *
 * Fails closed in the same direction as everything else here: an invalid
 * declaration becomes `null` (nothing declared) rather than a partially
 * accepted one. A half-understood statement about data handling is worse than
 * no statement, because it will be rendered as though it were complete.
 *
 * @param {object|null} declaration
 * @param {Function} [now] injected clock
 * @returns {object|null} normalized, or null if unusable
 */
export function normalizeDeclaration(declaration, now = () => Date.now()) {
  if (!declaration || typeof declaration !== 'object') return null;
  if (!SIGNAL_VALUES.has(declaration.signal)) return null;
  if (!DERIVED_VALUES.has(declaration.derivedMetadata)) return null;

  const recipients = Array.isArray(declaration.recipients)
    ? declaration.recipients.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim())
    : [];

  // A tool that says it shares derived metadata but names nobody has not
  // finished the declaration. "shared, recipients: []" is not a weaker claim
  // than "shared, recipients: [...]" — it is an unanswerable one.
  if (declaration.derivedMetadata === DERIVED_METADATA_HANDLING.SHARED && recipients.length === 0) {
    return null;
  }
  // The converse is also incoherent: naming recipients while claiming nothing
  // is shared. Refuse rather than pick which half to believe.
  if (declaration.derivedMetadata === DERIVED_METADATA_HANDLING.NONE && recipients.length > 0) {
    return null;
  }

  return Object.freeze({
    signal: declaration.signal,
    derivedMetadata: declaration.derivedMetadata,
    recipients: Object.freeze(recipients),
    declaredBy: typeof declaration.declaredBy === 'string' ? declaration.declaredBy : null,
    declaredAt: typeof declaration.declaredAt === 'string'
      ? declaration.declaredAt
      : new Date(now()).toISOString(),
    declarationVersion: typeof declaration.declarationVersion === 'string'
      ? declaration.declarationVersion
      : '1',
  });
}

/**
 * Render a host declaration as text a person can read.
 *
 * When there is no declaration this returns a statement of ABSENCE, in the
 * same weight a declaration would occupy. That placement is the point: the
 * earlier design left the whole section out, and a missing section reads as
 * "nothing to worry about" — an omission that functions as an assurance.
 */
export function declarationText(declaration = null) {
  if (!declaration) {
    return (
      'NOT DECLARED \u2014 the tool using this library has not stated what it ' +
      'does with your signal, or who receives derived data from it. This ' +
      'library will not state it on the tool\u2019s behalf, because only the ' +
      'tool can answer it truthfully.'
    );
  }

  const lines = [];
  lines.push(
    declaration.signal === SIGNAL_HANDLING.LOCAL_ONLY
      ? 'Your raw signal: stays on this device. The tool declares it is not transmitted.'
      : 'Your raw signal: the tool declares it IS transmitted off this device.'
  );

  if (declaration.derivedMetadata === DERIVED_METADATA_HANDLING.NONE) {
    lines.push('Derived data: the tool declares nothing derived from your signal is sent anywhere.');
  } else {
    lines.push(
      'Derived data: the tool declares it sends summaries derived from your ' +
      'signal to: ' + declaration.recipients.join(', ') + '. ' +
      'The "Send summaries to an online service" permission above covers this.'
    );
  }

  const by = declaration.declaredBy ? `Declared by ${declaration.declaredBy}` : 'Declared by this tool';
  lines.push(
    `${by} on ${declaration.declaredAt}. This is the tool\u2019s statement, not ` +
    'this library\u2019s \u2014 the library has no way to check it and does not ' +
    'vouch for it.'
  );
  return lines.join('\n');
}

/**
 * The disclaimer, stated once so every surface uses identical wording.
 *
 * WHY THIS TEXT IS LOAD-BEARING. The FTC\u2019s deception doctrine reaches ANY
 * claim a product makes, whether or not a privacy statute applies to the
 * publisher. So a tool that says "CCPA compliant" when applicability depends
 * on facts about the developer (revenue, consumer counts) is not being modest
 * \u2014 it is making a false claim, which is its own legal exposure. The honest
 * position is still the one this file took originally: describe the mechanics
 * precisely, decline to assert compliance, and say why.
 *
 * WHAT CHANGED, AND WHY IT HAD TO. The original `full` text ended with a
 * section headed "WHAT IS ACTUALLY TRUE" containing this sentence:
 *
 *   "Your signal is processed on this device and is not transmitted. There is
 *    no server receiving it, so there is nobody to sell it to ... That is a
 *    statement about this software, and you can verify it."
 *
 * Every clause of that is true of THIS LIBRARY and none of it is knowable
 * about the tool embedding it. It was rendered into the host\u2019s UI, next to
 * the host\u2019s consent screen, under a heading that claimed truth. A host that
 * later adds one optional online feature \u2014 the exact shape
 * SHARE_DERIVED_METADATA exists to cover \u2014 would have this library telling
 * its users, in the host\u2019s own interface, something false. The library would
 * have made the false claim, about code it does not control, and put it on
 * screen.
 *
 * So the section is gone. It is replaced by a claim the library can actually
 * support ("this consent layer transmits nothing", checked in CI by
 * scripts/audit-no-network.py) and a statement of what the library cannot know,
 * followed by the host\u2019s own declaration or the absence of one.
 *
 * This wording still deliberately avoids: "compliant", "certified", "HIPAA",
 * "FDA cleared", "GDPR", and "privacy compliant by architecture". The last is
 * the overclaim a comparable project shipped; architecture is evidence, not a
 * legal conclusion.
 */
export const DISCLAIMER = {
  version: '1.1.0',
  short:
    'This tool handles your data in the ways described above. It does not ' +
    'claim to satisfy any particular privacy law.',
  full:
    'WHAT THIS DOES\n' +
    'This consent layer records what you agreed to, lets you change or withdraw ' +
    'it at any time, and keeps a local record of those changes. It implements ' +
    'the consent mechanics described in the ISO/IEC TS 27560 field model.\n\n' +
    'WHAT THIS DOES NOT DO\n' +
    'It does not make this tool "compliant" with any specific law. Whether a ' +
    'law applies depends on facts about whoever publishes the tool \u2014 their ' +
    'revenue, how many people use it, and where those people live \u2014 not on ' +
    'what the code does. A consent screen cannot change that.\n\n' +
    'Specifically: this is not a claim of CCPA, CPA, CTDPA, or VDPOSA ' +
    'compliance. It is not a HIPAA claim (HIPAA generally does not apply to a ' +
    'direct-to-consumer tool with no health-care provider involved). It is not ' +
    'an FDA claim. ISO/IEC TS 27560 is a technical specification with no ' +
    'certification programme, so "structured per 27560" describes the record ' +
    'format and nothing more.\n\n' +
    'WHAT IS TRUE OF THIS LIBRARY\n' +
    'The consent layer you are reading has no network code. No fetch, no ' +
    'beacon, no websocket, no configurable endpoint \u2014 consent records are ' +
    'written to storage the tool supplies, or held in memory. You can read the ' +
    'source and check; the project also runs that check on every commit.\n\n' +
    'WHAT THIS LIBRARY CANNOT TELL YOU\n' +
    'Whether the tool AROUND this library transmits anything is a separate ' +
    'question, and this library is not in a position to answer it. So it does ' +
    'not. Whatever the tool declares about its own handling is shown below, ' +
    'said in the tool\u2019s voice rather than this one.',
};

/**
 * The complete disclaimer text, with the host\u2019s declaration attached.
 *
 * This is what a UI should render. `DISCLAIMER.full` alone is only the part
 * that is true regardless of who embeds it — safe to show, but incomplete
 * without the declaration section.
 */
export function disclaimerText(declaration = null) {
  return (
    `${DISCLAIMER.full}\n\n` +
    'WHAT THIS TOOL DECLARES ABOUT ITSELF\n' +
    declarationText(declaration)
  );
}

/** Concatenate the key texts for the initial panel. */
export function keyInformationText(purposes = DEFAULT_PURPOSES) {
  return purposes.map((p) => `\u2022 ${p.keyText}`).join('\n\n');
}

/** Look up a purpose by id, or null. Searches every purpose, including opt-ins. */
export function purposeById(id) {
  return ALL_PURPOSES.find((p) => p.id === id) ?? null;
}

/**
 * Resolve a list of ids (or definitions) to definitions, refusing unknowns.
 * Throws rather than dropping: a tool that asks for a purpose this module does
 * not have has a bug, and silently presenting one fewer permission would hide
 * a real mismatch between the tool and its notice.
 */
export function resolvePurposes(ids) {
  return ids.map((entry) => {
    if (entry && typeof entry === 'object' && entry.id) return entry;
    const found = purposeById(entry);
    if (!found) throw new Error(`unknown purpose: ${entry}`);
    return found;
  });
}

/**
 * A stable identifier for the notice bundle as a whole. Recorded in every
 * consent record so the exact text a person saw is reconstructable later.
 *
 * Scoped to the purposes actually PRESENTED, not to everything this module
 * knows — a tool that never shows the fifth purpose must not stamp its notice
 * version with it.
 */
export function noticeVersion(purposes = DEFAULT_PURPOSES) {
  return purposes
    .map((p) => `${p.id}@${p.version}`)
    .sort()
    .join('+');
}
