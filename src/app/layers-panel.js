// Layer panel: visibility toggles, isolate, colour swatches, filter.
import { $, esc } from './ui.js';
import { FG } from '../model.js';

export class LayersPanel {
  /** onChange(visibleArray) is called after any visibility change. */
  constructor(onChange) {
    this.onChange = onChange;
    this.layers = [];
    this.visible = new Uint8Array(0);
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

  setLayers(layers) {
    this.layers = layers;
    this.visible = new Uint8Array(layers.length);
    layers.forEach((l, i) => { this.visible[i] = l.visible ? 1 : 0; });
    const rows = [];
    const order = layers.map((l, i) => i).filter((i) => layers[i].count > 0 || (layers[i].name !== '0' && !/^Level \d+$/.test(layers[i].name)))
      .sort((a, b) => layers[a].name.localeCompare(layers[b].name, undefined, { numeric: true }));
    for (const i of order) {
      const l = layers[i];
      const sw = l.color === FG ? '<span class="sw fg" title="White on dark, black on paper"></span>'
        : `<span class="sw" style="background:#${(l.color & 0xffffff).toString(16).padStart(6, '0')}"></span>`;
      rows.push(`<li class="layer${this.visible[i] ? '' : ' off'}" data-name="${esc(l.name.toLowerCase())}">
        <label><input type="checkbox" data-i="${i}" ${this.visible[i] ? 'checked' : ''}>${sw}<span class="lname" title="${esc(l.name)}">${esc(l.name)}</span><span class="ln-count">${l.count}</span></label>
        <button type="button" class="btn icon sm iso" data-i="${i}" title="Show only this layer" aria-label="Show only ${esc(l.name)}"><svg class="ic" aria-hidden="true"><use href="#i-target"/></svg></button>
      </li>`);
    }
    this.list.innerHTML = rows.join('');
    $('#layers-count').textContent = `(${order.length})`;
    this.filter.value = '';
    this.filter.parentElement.hidden = order.length < 2;
  }

  sync() {
    for (const cb of this.list.querySelectorAll('input[type="checkbox"]')) {
      const i = Number(cb.dataset.i);
      cb.checked = !!this.visible[i];
      cb.closest('.layer').classList.toggle('off', !cb.checked);
    }
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
    for (const li of this.list.children) li.hidden = q && !li.dataset.name.includes(q);
  }
}
