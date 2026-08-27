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
//     skipped: [ <question ids> ],
//     pace:    { samples: [ <seconds per answered question> ], peak: <percent> }
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
        skipped: [],
        pace: { samples: [], peak: 0 }
      };

  // A state saved before pace tracking existed has neither field.
  if (!state.pace || !Array.isArray(state.pace.samples)) {
    state.pace = { samples: [], peak: 0 };
  }

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

  // -- pacing ---------------------------------------------------------------
  //
  // The estimate of time remaining is built from how long *this* user has
  // actually been taking, not from a fixed guess: a hands-free user on a slow
  // connection and a fast typist differ by more than a factor of three, and a
  // single number for both is worse than no number at all.
  //
  // Only the wall-clock gap between serving a question and receiving its
  // answer is sampled. It is deliberately not persisted across a save/resume
  // gap, and a sample longer than IDLE_CUTOFF is dropped entirely — a user who
  // walks away mid-interview would otherwise poison the average with a
  // twenty-minute "answer".

  const IDLE_CUTOFF = 180; // seconds; longer than this is a break, not thinking
  const PACE_WINDOW = 12;  // samples kept; recent pace beats lifetime average
  const now = () => Date.now() / 1000;

  // Not part of `state`: a resumed interview starts timing fresh rather than
  // counting the hours the page was closed as one very slow answer.
  let lastAskedAt = null;

  /** Called when a question is handed to the caller, to start its clock. */
  function markAsked() {
    lastAskedAt = now();
  }

  /** Called when an answer arrives, to close the clock opened by markAsked. */
  function recordPace() {
    if (lastAskedAt == null) return;
    const elapsed = now() - lastAskedAt;
    lastAskedAt = null;
    if (!(elapsed > 0) || elapsed > IDLE_CUTOFF) return;
    state.pace.samples.push(elapsed);
    if (state.pace.samples.length > PACE_WINDOW) state.pace.samples.shift();
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

  /**
   * The question to ask right now, or null when the interview is complete.
   *
   * Callers poll this freely (the UI re-reads it on repeat, on redraw, after a
   * correction), so the pacing clock is armed only when the question actually
   * changes. Re-arming on every call would reset the timer each time the user
   * asked for a repeat and make them look artificially fast.
   */
  function current() {
    const q = buildCurrent();
    const key = q ? q.path.join('/') : null;
    if (key !== currentKey) {
      currentKey = key;
      if (q) markAsked(); else lastAskedAt = null;
    }
    return q;
  }

  let currentKey = null;

  function buildCurrent() {
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
    recordPace();
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
   * Progress, counted in individual questions rather than schema nodes.
   *
   * A loop is not one unit: a provider list with eight entries is forty
   * questions, and counting it as one made the percentage sit still for
   * several minutes in the middle of the interview. So each loop contributes
   * its *actual* items times its askable fields, plus one entry prompt per
   * item and one closing "any more?".
   *
   * That makes the denominator grow as the user adds items, which is exactly
   * the thing that would make a spoken percentage walk backward. Two things
   * keep it from doing so:
   *
   *   - a loop not yet reached is budgeted at one item, so arriving at it and
   *     saying yes does not come as a surprise to the total;
   *   - the reported `percent` is a high-water mark held in state. When the
   *     honest fraction dips because a ninth provider was added, the spoken
   *     number holds still instead of retreating. `rawPercent` carries the
   *     un-clamped value for anything that would rather have the truth.
   *
   * Holding still is the correct failure: the user who keeps adding items is
   * genuinely not getting closer to the end, and "still about 60 percent" is
   * an honest thing to hear.
   */
  function progress() {
    const { answered, total } = countQuestions();
    const done = Math.min(answered, total);
    const raw = total ? Math.round((done / total) * 100) : 100;

    // Never announce a smaller number than last time.
    if (raw > state.pace.peak) state.pace.peak = raw;
    const percent = Math.min(state.pace.peak, 100);

    const node = nodeAt(state.cursor.node);
    return {
      section: node?.section ?? null,
      sectionTitle: node?.sectionTitle ?? null,
      sectionNumber: node ? sections.findIndex(s => s.id === node.section) + 1 : sections.length,
      sectionCount: sections.length,
      answered: done,
      remaining: Math.max(0, total - done),
      total,
      percent,
      rawPercent: raw,
      secondsRemaining: estimateSeconds(Math.max(0, total - done))
    };
  }

  /**
   * Walk the whole schema and count questions on both sides of the cursor.
   *
   * askIf predicates are evaluated as they would be at ask time, so a branch
   * the user has already closed off (no workers' comp claim, no spouse) drops
   * out of the total rather than sitting in it as work that will never happen.
   * Predicates for questions not yet reached are evaluated against the answers
   * so far, which is the best guess available; they are re-evaluated on every
   * call, so the estimate sharpens as the interview goes.
   */
  function countQuestions() {
    let total = 0;
    let answered = 0;
    const cursor = state.cursor;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const past = i < cursor.node;
      const current = i === cursor.node;

      if (node.type !== 'loop') {
        if (!shouldAsk(node, state.answers)) continue;
        total += 1;
        if (past) answered += 1;
        continue;
      }

      const items = Array.isArray(state.answers[node.id]) ? state.answers[node.id] : null;

      // Fields of an item, counting only those its own answers keep askable.
      const fieldsFor = item =>
        node.fields.reduce((n, f) => n + (shouldAsk(f, item ?? {}) ? 1 : 0), 0);

      // An entry prompt that doubles as its first field is one question, not
      // two — the engine stores nothing for it and steps straight to fields.
      const entryCost = node.entryIsFirstField ? 0 : 1;

      if (past) {
        // Settled: however many items it ended up with, plus the entry prompt
        // for each and the final "no". All of it is behind the cursor.
        const list = items ?? [];
        let cost = entryCost; // the closing "any more?", answered no
        for (const item of list) cost += entryCost + fieldsFor(item);
        total += cost;
        answered += cost;
        continue;
      }

      if (!current) {
        // Not yet reached. Budget one item so that walking into it and saying
        // yes does not inflate the total mid-interview. A loop the user will
        // decline costs one question instead of the budgeted item — an
        // over-estimate, which is the safe direction for a time estimate.
        total += entryCost + fieldsFor(null);
        continue;
      }

      // The loop the cursor is inside. Completed items are fully counted and
      // fully answered; the open item is counted whole and credited for the
      // fields already walked past.
      const list = items ?? [];
      const openIndex = cursor.phase === 'field' ? cursor.loopIndex : -1;

      list.forEach((item, idx) => {
        const cost = entryCost + fieldsFor(item);
        total += cost;
        if (idx < openIndex || cursor.phase === 'entry') answered += cost;
        else if (idx === openIndex) answered += entryCost + fieldsAnsweredIn(node, item);
      });

      if (cursor.phase === 'entry') {
        // Sitting on "another one?". Budget one more item if the loop is
        // empty (they will almost certainly say yes to the first), otherwise
        // just the entry prompt itself.
        total += list.length === 0 ? entryCost + fieldsFor(null) : entryCost;
      } else {
        total += entryCost; // the closing "any more?" still to come
      }
    }

    return { answered, total };
  }

  /** Fields of the open item the cursor has already walked past. */
  function fieldsAnsweredIn(node, item) {
    let n = 0;
    for (let i = 0; i < state.cursor.fieldIndex && i < node.fields.length; i++) {
      if (shouldAsk(node.fields[i], item ?? {})) n += 1;
    }
    return n;
  }

  /**
   * Seconds of interview left, or null until there is enough evidence.
   *
   * Two samples is not a pace — the first question of the interview is always
   * slow (the user is still working out what the tone means) and the second is
   * often fast. Below MIN_SAMPLES the honest answer is "I do not know yet",
   * and callers say so rather than reading out a number built from noise.
   *
   * The median is used rather than the mean because one 90-second answer —
   * hunting for an insurance card, re-reading a prompt — should not double the
   * estimate for the remaining forty questions.
   */
  const MIN_SAMPLES = 4;

  function estimateSeconds(remaining) {
    const samples = state.pace.samples;
    if (samples.length < MIN_SAMPLES) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
    return Math.round(median * remaining);
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
      state.pace = { samples: [], peak: 0 };
      lastAskedAt = null;
      return current();
    }
  };
}
