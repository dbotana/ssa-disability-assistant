// Reading back a file written by downloadJson().
//
// The export is the only way to move a session between devices, so the parser
// here is deliberately forgiving about shape and strict about types: anything
// it cannot vouch for is dropped rather than handed to the engine, which
// assumes its own state is well formed.
//
// Two file versions exist:
//   v1  { version: 1, savedAt, answers }        — answers only, no cursor
//   v2  { version: 2, savedAt, answers, state } — the full engine state
//
// A v1 file (or a v2 file whose cursor does not fit the current schema) still
// imports: the answers are kept and the cursor is rebuilt by replaying the
// schema, which lands on the first question that has no answer.

import { SECTIONS, flatten } from './schema.js';

export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportError';
  }
}

const MAX_BYTES = 5 * 1024 * 1024;   // an interview is tens of KB; this is slop

/**
 * Parse the text of an exported file into { state, savedAt, rebuiltCursor }.
 * Throws ImportError with a sentence fit to be spoken aloud.
 */
export function parseExport(text, sections = SECTIONS) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError('That file is not a saved answers file. It could not be read as JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ImportError('That file does not look like a saved answers file.');
  }

  const answers = sanitizeAnswers(parsed.answers, sections);
  if (!answers || Object.keys(answers).length === 0) {
    throw new ImportError('That file has no answers in it. Choose the file you saved from this page.');
  }

  const savedAt = typeof parsed.savedAt === 'string' ? parsed.savedAt : null;

  const nodes = flatten(sections);
  const saved = parsed.state && typeof parsed.state === 'object' ? parsed.state : null;
  const cursor = validCursor(saved?.cursor, nodes, answers);

  const state = {
    answers,
    cursor: cursor ?? rebuildCursor(nodes, answers),
    history: [],
    skipped: Array.isArray(saved?.skipped) ? saved.skipped.filter(id => typeof id === 'string') : [],
    pace: validPace(saved?.pace)
  };

  return { state, savedAt, rebuiltCursor: !cursor };
}

/** Read a File (or Blob) and parse it. Rejects with ImportError. */
export async function readExportFile(file, sections = SECTIONS) {
  if (!file) throw new ImportError('No file was chosen.');
  if (file.size > MAX_BYTES) {
    throw new ImportError('That file is too large to be a saved answers file.');
  }
  let text;
  try {
    text = await file.text();
  } catch {
    throw new ImportError('That file could not be opened.');
  }
  return parseExport(text, sections);
}

// -- validation -------------------------------------------------------------

/**
 * Keep only ids the current schema knows, with the value shape that id expects.
 * A loop id must carry an array of plain objects; everything else a scalar.
 * Unknown ids are dropped: a file from an older schema imports the part of
 * itself that still means something rather than failing whole.
 */
function sanitizeAnswers(raw, sections) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const section of sections) {
    for (const q of section.questions) {
      if (!(q.id in raw)) continue;
      const value = raw[q.id];
      if (q.type === 'loop') {
        if (!Array.isArray(value)) continue;
        const fieldIds = new Set(q.fields.map(f => f.id));
        const items = value
          .filter(item => item && typeof item === 'object' && !Array.isArray(item))
          .map(item => {
            const kept = {};
            for (const [k, v] of Object.entries(item)) {
              if (fieldIds.has(k) && isScalar(v)) kept[k] = v;
            }
            return kept;
          })
          .filter(item => Object.keys(item).length > 0);
        if (items.length) out[q.id] = items;
        continue;
      }
      if (isScalar(value)) out[q.id] = value;
    }
  }
  return out;
}

const isScalar = v =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** A cursor is usable only if it points at a position this schema still has. */
function validCursor(cursor, nodes, answers) {
  if (!cursor || typeof cursor !== 'object') return null;
  const { node, phase, loopIndex, fieldIndex } = cursor;
  if (!Number.isInteger(node) || node < 0 || node > nodes.length) return null;
  if (node === nodes.length) {
    // A finished interview: the cursor sits one past the last node.
    return { node, phase: null, loopIndex: 0, fieldIndex: 0 };
  }
  const target = nodes[node];
  if (target.type === 'loop') {
    if (phase !== 'entry' && phase !== 'field') return null;
    if (!Number.isInteger(loopIndex) || loopIndex < 0) return null;
    if (!Number.isInteger(fieldIndex) || fieldIndex < 0 || fieldIndex >= target.fields.length) return null;
    if (phase === 'field') {
      const items = answers[target.id];
      if (!Array.isArray(items) || loopIndex >= items.length) return null;
    }
    return { node, phase, loopIndex, fieldIndex: phase === 'entry' ? 0 : fieldIndex };
  }
  if (phase != null && phase !== 'entry' && phase !== 'field') return null;
  return { node, phase: null, loopIndex: 0, fieldIndex: 0 };
}

function validPace(pace) {
  const samples = Array.isArray(pace?.samples)
    ? pace.samples.filter(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
    : [];
  const peak = typeof pace?.peak === 'number' && Number.isFinite(pace.peak) ? pace.peak : 0;
  return { samples, peak };
}

/**
 * Walk the schema and stop at the first question with no answer. askIf is not
 * consulted: a skipped branch has no answer either, so the engine's own
 * advance() re-evaluates the conditions the moment the interview resumes.
 */
function rebuildCursor(nodes, answers) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type !== 'loop') {
      if (answers[node.id] === undefined) return { node: i, phase: null, loopIndex: 0, fieldIndex: 0 };
      continue;
    }
    const items = answers[node.id];
    if (!Array.isArray(items) || items.length === 0) {
      return { node: i, phase: 'entry', loopIndex: 0, fieldIndex: 0 };
    }
    // Resume inside the last item if it is missing a field, otherwise at the
    // "add another?" prompt for that loop.
    const last = items.length - 1;
    const fieldIndex = node.fields.findIndex(f => items[last][f.id] === undefined);
    if (fieldIndex >= 0) return { node: i, phase: 'field', loopIndex: last, fieldIndex };
    return { node: i, phase: 'entry', loopIndex: items.length, fieldIndex: 0 };
  }
  return { node: nodes.length, phase: null, loopIndex: 0, fieldIndex: 0 };
}
