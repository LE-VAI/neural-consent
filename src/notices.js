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
 */

/**
 * The purposes this module can record consent for.
 *
 * Granularity is deliberate and minimal. ISO/IEC TS 27560 and the state laws
 * both require PURPOSE LIMITATION: consent to one thing must not silently
 * authorise another. A blanket "I agree" fails that, so each purpose is
 * separate and separate consent is required for each.
 *
 * These are the four things a local-first access-input-style tool actually
 * does. There is no "analytics" and no "improve our services" purpose,
 * because this tool does neither — including a purpose you do not use is its
 * own kind of dishonesty.
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
};

/**
 * The disclaimer, stated once and exported so every surface uses identical
 * wording.
 *
 * WHY THIS TEXT IS LOAD-BEARING. The FTC\u2019s deception doctrine reaches ANY
 * claim a product makes, whether or not a privacy statute applies to the
 * publisher. So a tool that says "CCPA compliant" when applicability depends
 * on facts about the developer (revenue, consumer counts) is not being modest
 * \u2014 it is making a false claim, which is its own legal exposure. The honest
 * position is the one below: describe the mechanics precisely, decline to
 * assert compliance, and say why.
 *
 * This wording deliberately avoids: "compliant", "certified", "HIPAA",
 * "FDA cleared", "GDPR", and "privacy compliant by architecture". The last is
 * the overclaim a comparable project shipped; architecture is evidence, not a
 * legal conclusion.
 */
export const DISCLAIMER = {
  version: '1.0.0',
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
    'WHAT IS ACTUALLY TRUE\n' +
    'Your signal is processed on this device and is not transmitted. There is ' +
    'no server receiving it, so there is nobody to sell it to, no third party ' +
    'to share it with, and no database to breach. That is a statement about ' +
    'this software, and you can verify it.',
};

/** Concatenate the key texts for the initial panel. */
export function keyInformationText(purposes = Object.values(PURPOSES)) {
  return purposes.map((p) => `\u2022 ${p.keyText}`).join('\n\n');
}

/** Look up a purpose by id, or null. */
export function purposeById(id) {
  return Object.values(PURPOSES).find((p) => p.id === id) ?? null;
}

/**
 * A stable identifier for the notice bundle as a whole. Recorded in every
 * consent record so the exact text a person saw is reconstructable later.
 */
export function noticeVersion(purposes = Object.values(PURPOSES)) {
  return purposes
    .map((p) => `${p.id}@${p.version}`)
    .sort()
    .join('+');
}
