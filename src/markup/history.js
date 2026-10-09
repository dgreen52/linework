// One undo/redo stack for everything the user does: markup changes (snapshots of the small
// markup list) and drawing edits (change lists from edit/doc.js, entries with kind 'edit').
// Ctrl+Z always undoes the most recent action, whichever kind it was.
import { cloneMarkups } from './model.js';

export class History {
  constructor(limit = 200) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }
  /** Markups: call BEFORE a change with the current list. */
  record(current) { this.push(cloneMarkups(current)); }
  /** Drawing edit (already applied): an entry { kind: 'edit', ... }. */
  push(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  peek() { return this.undoStack[this.undoStack.length - 1] || null; }
  /**
   * Undo. Returns the previous markup list (markup step), or the edit entry to revert
   * ({ kind: 'edit' }), or null when there is nothing to undo.
   */
  undo(current) {
    if (!this.undoStack.length) return null;
    const e = this.undoStack.pop();
    this.redoStack.push(e.kind === 'edit' ? e : cloneMarkups(current));
    return e;
  }
  /** Redo. Returns the next markup list, or the edit entry to re-apply, or null. */
  redo(current) {
    if (!this.redoStack.length) return null;
    const e = this.redoStack.pop();
    this.undoStack.push(e.kind === 'edit' ? e : cloneMarkups(current));
    return e;
  }
  clear() { this.undoStack.length = 0; this.redoStack.length = 0; }
}
