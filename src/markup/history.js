// Snapshot-based undo/redo for the markup list (markup lists are small; snapshots are cheap).
import { cloneMarkups } from './model.js';

export class History {
  constructor(limit = 200) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }
  /** Call BEFORE a change with the current list. */
  record(current) {
    this.undoStack.push(cloneMarkups(current));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  undo(current) {
    if (!this.undoStack.length) return null;
    this.redoStack.push(cloneMarkups(current));
    return this.undoStack.pop();
  }
  redo(current) {
    if (!this.redoStack.length) return null;
    this.undoStack.push(cloneMarkups(current));
    return this.redoStack.pop();
  }
  clear() { this.undoStack.length = 0; this.redoStack.length = 0; }
}
