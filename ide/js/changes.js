/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// CHANGES.JS — what to do with a change on disk
// ============================================
//
// Pure on purpose: the IDE's poller asks this what each new revision means for
// the buffers it has open, and the answer is the part worth testing — the
// polling itself is a timer and a fetch.
//
// The rules, and why:
//
//   * A file that is open and CLEAN reloads. Nothing of the user's can be lost,
//     and an agent edit appearing in the editor is the whole point.
//   * A file that is open and DIRTY is a conflict. Never clobber typing: the
//     human's unsaved buffer wins until they choose "load theirs".
//   * A file that is not open, or is binary, is ignored by the editor (the tree
//     picks it up on its next refresh).
//
// `skip` exists for the IDE's own saves: the rev log records every write, so a
// save would come straight back as "changed on disk" and flash the tab the
// operator just saved. The caller passes the paths it wrote seconds ago.

/** Paths compare with forward slashes and no leading slash. */
function normPath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^\.?\//, '');
}

/**
 * @param {Array<{path:string,binary?:boolean,modified?:boolean}>} tabs
 * @param {Array<{path:string,op?:string,actor?:string,rev?:number}>} changes
 * @param {Set<string>|Array<string>} [skip] paths whose changes are our own echo
 * @returns {{reload: string[], conflict: Array<{path:string,actor:string,op:string,rev:number}>, ignore: string[]}}
 */
export function planChanges(tabs, changes, skip) {
  const skipSet = skip instanceof Set ? skip : new Set((skip || []).map(normPath));
  const reload = new Set();
  const ignore = new Set();
  const conflict = new Map();

  for (const change of changes || []) {
    const path = normPath(change && change.path);
    if (!path) continue;
    if (skipSet.has(path)) continue;

    const doc = (tabs || []).find((t) => normPath(t.path) === path);
    if (!doc || doc.binary) {
      ignore.add(path);
      continue;
    }
    if (doc.modified) {
      conflict.set(path, {
        path,
        actor: String((change && change.actor) || 'user'),
        op: String((change && change.op) || 'write'),
        rev: Number((change && change.rev) || 0),
      });
      continue;
    }
    reload.add(path);
  }

  return { reload: [...reload], conflict: [...conflict.values()], ignore: [...ignore] };
}

/** One line describing who changed what, for the conflict bar. */
export function describeChange({ path, actor, op }) {
  const who = actor === 'agent' || String(actor).startsWith('agent') ? 'an agent' : 'another editor';
  const verb = op === 'delete' ? 'deleted' : 'changed';
  return `${path} was ${verb} by ${who}`;
}

export default { planChanges, describeChange };
