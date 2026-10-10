// Layer panel: visibility toggles, isolate, colour swatches, filter.
import { $, esc } from './ui.js';
import { FG } from '../model.js';

/**
 * Layers worth listing: anything with items, named layers, and layers made in this session; empty
 * placeholders ("0", unused DGN "Level N") are left out. Every layer count shown to the user uses this.
 */
export function listedLayers(layers) {
  return layers.map((l, i) => i).filter((i) => {
    const l = layers[i];
    return !l.removed && (l.count > 0 || l.added || (l.name !== '0' && !/^Level \d+$/.test(l.name)));
  });
}

export class LayersPanel {
  /** onChange(visibleArray) is called after any visibility change. */
  constructor(onChange) {
    this.onChange = onChange;
    this.layers = [];
    this.visible = new Uint8Array(0);
    this.order = [];
    this.list = $('#layer-list');
    this.filter = $('#layer-filter');
    this.filter.addEventListener('input', () => this.applyFilter());
    $('#btn-layers-all').addEventListener('click', () => this.showAll());
    this.list.addEventListener('change', (e) => {
      const cb = e.target.closest('input[type="checkbox"]');
      if (!cb) return;
      const i = Number(cb.dataset.i);
      this.visible[i] = cb.checked ? 1 : 0;
      cb.closest('.layer').classList.toggle('off', !cb.checked);
      this.onChange(this.visible);
    });
    this.list.addEventListener('click', (e) => {
      const b = e.target.closest('button.iso');
      if (!b) return;
      this.isolate(Number(b.dataset.i));
    });
  }

  /** A new drawing: its layers, visibility from the file. */
  setLayers(layers) {
    this.layers = layers;
    this.visible = new Uint8Array(layers.length);
    layers.forEach((l, i) => { this.visible[i] = l.visible ? 1 : 0; });
    this.filter.value = '';
    this.render();
  }

  /**
   * The drawing was edited: new layers, item counts. Visibility and the filter are kept; only the
   * counts are touched unless the list of layers to show changed. Returns the visibility array
   * (a new one when layers were added).
   */
  refresh() {
    const layers = this.layers;
    if (this.visible.length < layers.length) {
      const v = new Uint8Array(layers.length);
      v.set(this.visible);
      for (let i = this.visible.length; i < layers.length; i++) v[i] = layers[i].visible === false ? 0 : 1;
      this.visible = v;
    }
    const order = listedLayers(layers);
    const same = order.length === this.order.length && order.every((i, k) => i === this.order[k]);
    if (!same) this.render();
    else for (const el of this.list.querySelectorAll('.ln-count')) el.textContent = String(layers[Number(el.dataset.i)].count);
    return this.visible;
  }

  render() {
    const layers = this.layers;
    this.order = listedLayers(layers);
    const order = this.order.slice().sort((a, b) => layers[a].name.localeCompare(layers[b].name, undefined, { numeric: true }));
    const rows = [];
    for (const i of order) {
      const l = layers[i];
      const sw = l.color === FG ? '<span class="sw fg" title="White on dark, black on paper"></span>'
        : `<span class="sw" style="background:#${(l.color & 0xffffff).toString(16).padStart(6, '0')}"></span>`;
      rows.push(`<li class="layer${this.visible[i] ? '' : ' off'}" data-name="${esc(l.name.toLowerCase())}">
        <label><input type="checkbox" data-i="${i}" ${this.visible[i] ? 'checked' : ''}>${sw}<span class="lname" title="${esc(l.name)}">${esc(l.name)}</span><span class="ln-count" data-i="${i}">${l.count}</span></label>
        <button type="button" class="btn icon sm iso" data-i="${i}" title="Show only this layer" aria-label="Show only ${esc(l.name)}"><svg class="ic" aria-hidden="true"><use href="#i-target"/></svg></button>
      </li>`);
    }
    this.list.innerHTML = rows.join('');
    $('#layers-count').textContent = `(${order.length})`;
    this.filter.parentElement.hidden = order.length < 2;
    this.applyFilter();
  }

  sync() {
    for (const cb of this.list.querySelectorAll('input[type="checkbox"]')) {
      const i = Number(cb.dataset.i);
      cb.checked = !!this.visible[i];
      cb.closest('.layer').classList.toggle('off', !cb.checked);
    }
  }

  /** Switch layers on (by index), e.g. after new items went on a hidden one. */
  show(indices) {
    for (const i of indices) if (i < this.visible.length) this.visible[i] = 1;
    this.sync();
    this.onChange(this.visible);
  }

  isolate(i) {
    const alreadyIsolated = this.visible[i] && this.visible.reduce((s, v) => s + v, 0) === 1;
    if (alreadyIsolated) this.visible.fill(1);
    else { this.visible.fill(0); this.visible[i] = 1; }
    this.sync();
    this.onChange(this.visible);
  }

  showAll() {
    this.visible.fill(1);
    this.sync();
    this.onChange(this.visible);
  }

  applyFilter() {
    const q = this.filter.value.trim().toLowerCase();
    for (const li of this.list.children) li.hidden = !!q && !li.dataset.name.includes(q);
  }
}
