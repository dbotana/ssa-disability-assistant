// Interview state machine.
//
// Walks the flattened schema, expanding loops at runtime. Owns all control
// flow: branching on yes/no, entering/repeating/exiting loop groups, dynamic
// askIf skips, back, and jumpTo. The LLM never drives navigation.
//
// State shape (serializable — this is exactly what store.js persists):
//   {
//     answers: { [id]: value, [loopId]: [ {field: value}, ... ] },
//     cursor:  { node: <index into nodes>, phase, loopIndex, fieldIndex },
//     history: [ <cursor snapshots, most recent last> ],
//     skipped: [ <question ids> ]
//   }
//
// Loop phases:
//   'entry'  asking entryPrompt / repeatPrompt
//   'field'  walking fields of the current loop item

import { flatten, SECTIONS } from './schema.js';

export function createEngine(sections = SECTIONS, savedState = null) {
  const nodes = flatten(sections);

  const state = savedState
    ? structuredClone(savedState)
    : {
        answers: {},
        cursor: { node: 0, phase: null, loopIndex: 0, fieldIndex: 0 },
        history: [],
        skipped: []
      };

  // -- helpers --------------------------------------------------------------

  const nodeAt = i => nodes[i] ?? null;

  /** The scope an askIf is evaluated against: the loop item, or the answer set. */
  function scopeFor(node) {
    if (node?.type === 'loop' && state.cursor.phase === 'field') {
      return currentItem() ?? {};
    }
    return state.answers;
  }

  function currentItem() {
    const node = nodeAt(state.cursor.node);
    if (!node || node.type !== 'loop') return null;
    const items = state.answers[node.id];
    return Array.isArray(items) ? items[state.cursor.loopIndex] ?? null : null;
  }

  function shouldAsk(q, scope) {
    if (typeof q.askIf !== 'function') return true;
    try {
      return !!q.askIf(scope);
    } catch {
      return true; // a throwing predicate must never strand the interview
    }
  }

  function snapshot() {
    state.history.push(structuredClone(state.cursor));
    // Bound the undo stack; nobody walks back further than this by voice.
    if (state.history.length > 200) state.history.shift();
  }

  // -- cursor movement ------------------------------------------------------

  /**
   * Advance the cursor to the next askable position, without recording an
   * answer. Skips questions whose askIf is false. Returns when it lands on
   * something askable or runs off the end.
   */
  function advance() {
    let guard = 0;
    while (guard++ < 10000) {
      const node = nodeAt(state.cursor.node);
      if (!node) return; // complete

      if (node.type !== 'loop') {
        state.cursor.node += 1;
        state.cursor.phase = null;
        const next = nodeAt(state.cursor.node);
        if (!next) return;
        if (next.type === 'loop') {
          state.cursor.phase = 'entry';
          state.cursor.loopIndex = 0;
          state.cursor.fieldIndex = 0;
          return;
        }
        if (shouldAsk(next, state.answers)) return;
        continue; // askIf false — keep walking
      }

      // Inside a loop.
      if (state.cursor.phase === 'entry') {
        // advance() past an entry means the user said yes; open an item.
        openItem(node);
        if (positionAtAskableField(node)) return;
        continue;
      }

      // phase === 'field': step to the next askable field, else back to entry.
      state.cursor.fieldIndex += 1;
      if (positionAtAskableField(node)) return;
      state.cursor.phase = 'entry';
      return;
    }
    throw new Error('engine: advance() failed to converge');
  }

  function openItem(node) {
    if (!Array.isArray(state.answers[node.id])) state.answers[node.id] = [];
    state.cursor.loopIndex = state.answers[node.id].length;
    state.answers[node.id].push({});
    state.cursor.phase = 'field';
    state.cursor.fieldIndex = 0;
  }

  /**
   * From cursor.fieldIndex, walk forward to the first field whose askIf holds.
   * Returns true if positioned on one, false if the item's fields are done.
   */
  function positionAtAskableField(node) {
    const item = currentItem() ?? {};
    while (state.cursor.fieldIndex < node.fields.length) {
      const f = node.fields[state.cursor.fieldIndex];
      if (shouldAsk(f, item)) return true;
      state.cursor.fieldIndex += 1;
    }
    return false;
  }

  /** Close the current loop (user said no at entry/repeat) and move on. */
  function closeLoop(node) {
    // A repeatPrompt "no" leaves the finished items in place; an entryPrompt
    // "no" on an untouched loop leaves an empty array, which reads as "none".
    if (!Array.isArray(state.answers[node.id])) state.answers[node.id] = [];
    state.cursor.node += 1;
    state.cursor.phase = null;
    state.cursor.loopIndex = 0;
    state.cursor.fieldIndex = 0;

    const next = nodeAt(state.cursor.node);
    if (!next) return;
    if (next.type === 'loop') {
      state.cursor.phase = 'entry';
      return;
    }
    if (!shouldAsk(next, state.answers)) advanceFromNonLoop();
  }

  function advanceFromNonLoop() {
    let guard = 0;
    while (guard++ < 10000) {
      const node = nodeAt(state.cursor.node);
      if (!node) return;
      if (node.type === 'loop') {
        state.cursor.phase = 'entry';
        state.cursor.loopIndex = 0;
        state.cursor.fieldIndex = 0;
        return;
      }
      if (shouldAsk(node, state.answers)) return;
      state.cursor.node += 1;
    }
  }

  // Position the cursor correctly on a fresh start.
  if (!savedState) {
    const first = nodeAt(0);
    if (first?.type === 'loop') state.cursor.phase = 'entry';
    else if (first && !shouldAsk(first, state.answers)) advanceFromNonLoop();
  }

  // -- public surface -------------------------------------------------------

  /** The question to ask right now, or null when the interview is complete. */
  function current() {
    const node = nodeAt(state.cursor.node);
    if (!node) return null;

    if (node.type !== 'loop') {
      return {
        id: node.id,
        prompt: node.prompt,
        type: node.type,
        required: !!node.required,
        confirm: !!node.confirm,
        warn: node.warn,
        hint: node.hint,
        section: node.section,
        sectionTitle: node.sectionTitle,
        path: [node.id]
      };
    }

    if (state.cursor.phase === 'entry') {
      const items = state.answers[node.id];
      const isRepeat = Array.isArray(items) && items.length > 0;
      return {
        id: `${node.id}__entry`,
        prompt: isRepeat ? node.repeatPrompt : node.entryPrompt,
        type: 'yesno',
        required: false,
        confirm: false,
        section: node.section,
        sectionTitle: node.sectionTitle,
        loopId: node.id,
        loopPhase: 'entry',
        itemLabel: node.itemLabel,
        itemNumber: (items?.length ?? 0) + 1,
        path: [node.id, 'entry', items?.length ?? 0]
      };
    }

    const f = node.fields[state.cursor.fieldIndex];
    if (!f) return null;
    return {
      id: f.id,
      prompt: f.prompt,
      type: f.type,
      required: !!f.required,
      confirm: !!f.confirm,
      warn: f.warn,
      hint: f.hint,
      section: node.section,
      sectionTitle: node.sectionTitle,
      loopId: node.id,
      loopPhase: 'field',
      itemLabel: node.itemLabel,
      itemNumber: state.cursor.loopIndex + 1,
      path: [node.id, state.cursor.loopIndex, f.id]
    };
  }

  /** Record a value for the current question and advance. Returns the next. */
  function submit(value) {
    const node = nodeAt(state.cursor.node);
    if (!node) return null;
    snapshot();

    if (node.type !== 'loop') {
      state.answers[node.id] = value;
      state.cursor.node += 1;
      advanceFromNonLoop();
      return current();
    }

    if (state.cursor.phase === 'entry') {
      if (value === true) {
        openItem(node);
        // An entry prompt that doubles as its own first field (e.g. conditions)
        // has nothing to store here; just position on the first field.
        if (!positionAtAskableField(node)) {
          state.cursor.phase = 'entry';
        }
      } else {
        closeLoop(node);
      }
      return current();
    }

    const item = currentItem();
    const f = node.fields[state.cursor.fieldIndex];
    if (item && f) item[f.id] = value;
    state.cursor.fieldIndex += 1;
    if (!positionAtAskableField(node)) state.cursor.phase = 'entry';
    return current();
  }

  /** Leave the current question unanswered and advance. */
  function skip() {
    const q = current();
    if (!q) return null;
    if (!state.skipped.includes(q.id)) state.skipped.push(q.id);
    // A skipped loop entry means "no more".
    if (q.loopPhase === 'entry') return submit(false);
    return submit(null);
  }

  /** Step back to the previous question, discarding its answer. */
  function back() {
    const prev = state.history.pop();
    if (!prev) return current();
    state.cursor = prev;
    const q = current();
    if (q) {
      // Discard the answer we are about to re-ask, so askIf re-evaluates clean.
      if (q.loopPhase === 'field') {
        const item = currentItem();
        if (item) delete item[q.id];
      } else if (q.loopPhase === 'entry') {
        const node = nodeAt(state.cursor.node);
        const items = state.answers[node.id];
        // Undo an item opened by the yes we are walking back over.
        if (Array.isArray(items) && items.length > state.cursor.loopIndex) {
          items.length = state.cursor.loopIndex;
        }
      } else {
        delete state.answers[q.id];
      }
    }
    return q;
  }

  /**
   * Jump to a specific question id, for the review-and-correct pass.
   *
   * Loop field ids are only unique within their loop — `name` and `phone`
   * appear in several — so a caller that knows which group it means passes
   * `loopId` to scope the search. Without it, the first match wins, which is
   * the historical behaviour used for the missing-required walk.
   */
  function jumpTo(questionId, loopIndex = 0, loopId = null) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.type !== 'loop') {
        if (loopId) continue;
        if (node.id === questionId) {
          snapshot();
          state.cursor = { node: i, phase: null, loopIndex: 0, fieldIndex: 0 };
          return current();
        }
        continue;
      }
      if (loopId && node.id !== loopId) continue;
      const fi = node.fields.findIndex(f => f.id === questionId);
      if (fi >= 0) {
        // Never point the cursor at an item that does not exist.
        const items = state.answers[node.id];
        if (!Array.isArray(items) || loopIndex >= items.length) return null;
        snapshot();
        state.cursor = { node: i, phase: 'field', loopIndex, fieldIndex: fi };
        return current();
      }
      if (node.id === questionId) {
        snapshot();
        state.cursor = { node: i, phase: 'entry', loopIndex, fieldIndex: 0 };
        return current();
      }
    }
    return null;
  }

  /**
   * Write one answer in place, without moving the cursor.
   *
   * This is what a correction is: the user is fixing a value they already
   * gave, and the forward walk should stay exactly where it was. Using
   * submit() here would advance the interview into whatever question happens
   * to follow the corrected one.
   */
  function setAnswer(questionId, value, { loopId = null, loopIndex = 0 } = {}) {
    if (loopId) {
      const node = nodes.find(n => n.id === loopId && n.type === 'loop');
      if (!node) return false;
      if (!node.fields.some(f => f.id === questionId)) return false;
      const items = state.answers[loopId];
      if (!Array.isArray(items) || !items[loopIndex]) return false;
      items[loopIndex][questionId] = value;
      return true;
    }
    const node = nodes.find(n => n.id === questionId && n.type !== 'loop');
    if (!node) return false;
    state.answers[questionId] = value;
    // A corrected answer may re-open questions an askIf had closed off.
    const idx = state.skipped.indexOf(questionId);
    if (idx >= 0 && value != null && value !== '') state.skipped.splice(idx, 1);
    return true;
  }

  /**
   * The recorded items of a loop, for naming them aloud ("provider 2, City
   * Clinic"). Returns [] for a loop with nothing in it, never null.
   */
  function listItems(loopId) {
    const node = nodes.find(n => n.id === loopId && n.type === 'loop');
    if (!node) return [];
    const items = state.answers[loopId];
    if (!Array.isArray(items)) return [];
    return items.map((item, index) => ({
      index,
      number: index + 1,
      itemLabel: node.itemLabel,
      // The first field is the name-ish one in every loop in this schema, and
      // is what a person uses to tell two items apart out loud.
      title: item?.[node.fields[0].id] ?? null,
      values: structuredClone(item ?? {})
    }));
  }

  /**
   * Delete one item from a loop.
   *
   * Removing an element renumbers every item after it, so any cursor holding
   * a loopIndex into this loop has to be repaired or it silently starts
   * pointing at a different person's answers. That means the live cursor and
   * every snapshot in the undo history:
   *
   *   - an index after the removed one shifts down by one
   *   - an index *equal* to it refers to something that no longer exists, so
   *     it is clamped back to the loop entry, where "add another?" is asked
   *
   * Returns false if the loop or the item does not exist.
   */
  function removeItem(loopId, loopIndex) {
    const nodeIndex = nodes.findIndex(n => n.id === loopId && n.type === 'loop');
    if (nodeIndex < 0) return false;
    const items = state.answers[loopId];
    if (!Array.isArray(items) || loopIndex < 0 || loopIndex >= items.length) return false;

    items.splice(loopIndex, 1);

    const repair = cursor => {
      if (cursor.node !== nodeIndex) return cursor;
      if (cursor.loopIndex > loopIndex) {
        cursor.loopIndex -= 1;
      } else if (cursor.loopIndex === loopIndex) {
        // The item this cursor was inside is gone. Park it on the entry
        // prompt rather than on a neighbour's half-answered fields.
        cursor.phase = 'entry';
        cursor.loopIndex = items.length;
        cursor.fieldIndex = 0;
      }
      return cursor;
    };

    repair(state.cursor);
    state.history = state.history.map(repair);
    return true;
  }

  /**
   * Coarse progress. Loop questions count as one unit each regardless of how
   * many items they hold — a percentage that jumps backward as the user adds
   * providers is worse than useless when it is being read aloud.
   */
  function progress() {
    const total = nodes.length;
    const done = Math.min(state.cursor.node, total);
    const node = nodeAt(state.cursor.node);
    return {
      section: node?.section ?? null,
      sectionTitle: node?.sectionTitle ?? null,
      sectionNumber: node ? sections.findIndex(s => s.id === node.section) + 1 : sections.length,
      sectionCount: sections.length,
      answered: done,
      total,
      percent: total ? Math.round((done / total) * 100) : 100
    };
  }

  /** Required questions with no recorded answer, for the review pass. */
  function missingRequired() {
    const missing = [];
    for (const node of nodes) {
      if (node.type === 'loop') {
        const items = state.answers[node.id] ?? [];
        items.forEach((item, idx) => {
          for (const f of node.fields) {
            if (!f.required) continue;
            if (!shouldAsk(f, item)) continue;
            if (item[f.id] == null || item[f.id] === '') {
              missing.push({ id: f.id, prompt: f.prompt, loopId: node.id, loopIndex: idx });
            }
          }
        });
        continue;
      }
      if (!node.required) continue;
      if (!shouldAsk(node, state.answers)) continue;
      if (state.answers[node.id] == null || state.answers[node.id] === '') {
        missing.push({ id: node.id, prompt: node.prompt });
      }
    }
    return missing;
  }

  return {
    current,
    submit,
    skip,
    back,
    jumpTo,
    setAnswer,
    listItems,
    removeItem,
    progress,
    missingRequired,
    answers: () => structuredClone(state.answers),
    isComplete: () => state.cursor.node >= nodes.length,
    getState: () => structuredClone(state),
    reset: () => {
      state.answers = {};
      state.cursor = { node: 0, phase: nodes[0]?.type === 'loop' ? 'entry' : null, loopIndex: 0, fieldIndex: 0 };
      state.history = [];
      state.skipped = [];
      return current();
    }
  };
}
