// Export file names (plan 4.7, Step 2 item 8).
//
//   ssa-starter-kit-<name>-<date>.pdf            one version, as today
//   ssa-starter-kit-<name>-<date>-lingala.pdf    version A in a Lingala session
//   ssa-starter-kit-<name>-<date>-english.pdf    version B, the translation
//
// Pure, so the apps name files exactly as the web does. Kotlin port:
// ExportNames in android/core, pinned by the `exportnames` golden.

import * as ssaKit from './forms/ssa-starter-kit.js';
import * as dsIntake from './forms/ds-intake.js';

// Read at call time: the form specs and the i18n corpus import each other.
const prefixOf = formId => ({ ssa: ssaKit.FILE_PREFIX, ds: dsIntake.FILE_PREFIX })[formId];

/** The suffix for each version; null is the single version every English session gets. */
export const VERSION_SUFFIXES = { lingala: '-lingala', english: '-english' };

/** Filename-safe version of the applicant's name. */
export const slug = s => String(s ?? '').trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');

/**
 * @param {'ssa'|'ds'} formId
 * @param {object} answers   first_name and last_name are used
 * @param {Date} date        stamped as its local YYYY-MM-DD
 * @param {null|'lingala'|'english'} version
 */
export function exportFileName(formId, answers, date, version = null) {
  const prefix = prefixOf(formId);
  if (!prefix) throw new Error(`Unknown form: ${formId}`);
  if (version !== null && !(version in VERSION_SUFFIXES)) throw new Error(`Unknown version: ${version}`);
  const who = slug([answers?.first_name, answers?.last_name].filter(Boolean).join(' '));
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `${prefix}${who ? `-${who}` : ''}-${stamp}${version ? VERSION_SUFFIXES[version] : ''}.pdf`;
}
