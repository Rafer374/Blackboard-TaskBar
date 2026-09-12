// ==UserScript==
// @name         Blackboard TaskBar
// @namespace    https://github.com/Rafer374/Blackboard-TaskBar
// @version      0.1.0
// @description  Local assignment to-do sidebar for Blackboard Learn Ultra. No backend, no telemetry, runs entirely in your browser.
// @author       Rafer374
// @license      PolyForm-Noncommercial-1.0.0; https://polyformproject.org/licenses/noncommercial/1.0.0
// @homepageURL  https://github.com/Rafer374/Blackboard-TaskBar
// @supportURL   https://github.com/Rafer374/Blackboard-TaskBar/issues
// @updateURL    https://github.com/Rafer374/Blackboard-TaskBar/raw/main/blackboard-taskbar.user.js
// @downloadURL  https://github.com/Rafer374/Blackboard-TaskBar/raw/main/blackboard-taskbar.user.js
// @match        https://blackboard.und.edu/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Blackboard TaskBar
 * Copyright (c) 2026 Rafer374
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Free for personal/noncommercial use. No reselling or commercial reuse.
 * Full text: https://polyformproject.org/licenses/noncommercial/1.0.0
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // refetch every 10 minutes
  const THIS_WEEK_DAYS = 7;                   // "This Week" = due within N days
  const STORAGE_KEY = 'bbTaskbar.v1';
  const PANEL_ID = 'bb-taskbar-root';

  // ---------------------------------------------------------------------------
  // Data source adapter
  //
  // Everything Blackboard-specific lives here. fetchAssignments() must resolve
  // to an array of normalized items:
  //   { id: string, name: string, courseName: string, courseId: string,
  //     dueAt: Date, points: number|null, url: string }
  // Only items with a due date and no submission/grade should be returned.
  //
  // PENDING: endpoint + parse() are filled in from a real captured response.
  // Until then fetchAssignments() throws, which the UI reports as
  // "couldn't load assignments" rather than breaking the page.
  // ---------------------------------------------------------------------------
  const DataSource = {
    // e.g. '/learn/api/v1/...'; null = not configured yet
    endpoint: null,

    async fetchAssignments() {
      if (!this.endpoint) {
        throw new Error('Data source not configured (endpoint is null)');
      }
      const res = await fetch(this.endpoint, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error('Not signed in to Blackboard (HTTP ' + res.status + ')');
      }
      if (!res.ok) {
        throw new Error('Blackboard returned HTTP ' + res.status);
      }
      let json;
      try {
        json = await res.json();
      } catch (e) {
        throw new Error('Response was not JSON');
      }
      const items = this.parse(json);
      if (!Array.isArray(items)) {
        throw new Error('Parser did not return a list');
      }
      return items;
    },

    // Turn the raw endpoint JSON into normalized items. Filled in after
    // inspecting a real response; must never throw on unexpected shapes,
    // just skip what it can't read.
    parse(_json) {
      throw new Error('Parser not implemented');
    },
  };

  // ---------------------------------------------------------------------------
  // Persistent state (GM storage, localStorage fallback)
  // ---------------------------------------------------------------------------
  const DEFAULT_STATE = {
    completed: {},      // { [assignmentId]: true }
    showCompleted: false,
    courseFilter: '',   // '' = all courses
    collapsed: false,
  };

  const Storage = {
    load() {
      let raw = null;
      try {
        if (typeof GM_getValue === 'function') raw = GM_getValue(STORAGE_KEY, null);
        else raw = localStorage.getItem(STORAGE_KEY);
      } catch (e) { /* ignore */ }
      if (!raw) return { ...DEFAULT_STATE, completed: {} };
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return { ...DEFAULT_STATE, ...parsed, completed: { ...(parsed.completed || {}) } };
      } catch (e) {
        return { ...DEFAULT_STATE, completed: {} };
      }
    },
    save(state) {
      const raw = JSON.stringify(state);
      try {
        if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY, raw);
        else localStorage.setItem(STORAGE_KEY, raw);
      } catch (e) { /* ignore */ }
    },
  };

  const state = Storage.load();
  let items = [];            // last successfully fetched, normalized items
  let lastError = null;      // string or null
  let lastUpdated = null;    // Date or null
  let loading = false;

  // ---------------------------------------------------------------------------
  // Bucketing
  // ---------------------------------------------------------------------------
  const BUCKETS = ['Overdue', 'Today', 'Tomorrow', 'This Week', 'Later'];

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function bucketFor(dueAt, now) {
    if (dueAt < now) return 'Overdue';
    const today = startOfDay(now);
    const dayMs = 24 * 60 * 60 * 1000;
    const dueDay = startOfDay(dueAt);
    const diffDays = Math.round((dueDay - today) / dayMs);
    if (diffDays <= 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    if (diffDays < THIS_WEEK_DAYS) return 'This Week';
    return 'Later';
  }

  function groupItems(list, now) {
    const groups = {};
    BUCKETS.forEach((b) => { groups[b] = []; });
    list.forEach((it) => { groups[bucketFor(it.dueAt, now)].push(it); });
    BUCKETS.forEach((b) => groups[b].sort((a, c) => a.dueAt - c.dueAt));
    return groups;
  }

  function visibleItems() {
    return items.filter((it) => {
      if (state.courseFilter && it.courseId !== state.courseFilter) return false;
      if (!state.showCompleted && state.completed[it.id]) return false;
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  function fmtDue(d) {
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    const date = d.toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
    });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return date + ' · ' + time;
  }

  function fmtPoints(p) {
    if (p === null || p === undefined || Number.isNaN(p)) return '';
    return (Number.isInteger(p) ? p : p.toFixed(2)) + ' pts';
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  const CSS = `
    #${PANEL_ID} {
      position: fixed; top: 64px; right: 12px; z-index: 2147483000;
      width: 340px; max-height: calc(100vh - 80px);
      display: flex; flex-direction: column;
      background: #fff; color: #222;
      border: 1px solid #d0d0d0; border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.18);
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    #${PANEL_ID} * { box-sizing: border-box; }
    #${PANEL_ID}.bbt-collapsed { width: auto; }
    #${PANEL_ID}.bbt-collapsed .bbt-body,
    #${PANEL_ID}.bbt-collapsed .bbt-controls,
    #${PANEL_ID}.bbt-collapsed .bbt-footer { display: none; }
    .bbt-header {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; border-bottom: 1px solid #e5e5e5;
      background: #f7f7f7; border-radius: 8px 8px 0 0; cursor: default;
    }
    #${PANEL_ID}.bbt-collapsed .bbt-header { border-bottom: none; border-radius: 8px; }
    .bbt-title { font-weight: 600; flex: 1; white-space: nowrap; }
    .bbt-count {
      background: #2b5797; color: #fff; border-radius: 10px;
      padding: 0 7px; font-size: 11px; font-weight: 600;
    }
    .bbt-btn {
      border: 1px solid #ccc; background: #fff; border-radius: 4px;
      padding: 2px 7px; cursor: pointer; font: inherit; line-height: 1.2;
    }
    .bbt-btn:hover { background: #eee; }
    .bbt-btn:disabled { opacity: 0.5; cursor: default; }
    .bbt-controls {
      display: flex; gap: 8px; align-items: center;
      padding: 6px 10px; border-bottom: 1px solid #e5e5e5;
    }
    .bbt-controls select { flex: 1; min-width: 0; font: inherit; padding: 2px 4px; }
    .bbt-controls label { white-space: nowrap; display: flex; gap: 4px; align-items: center; }
    .bbt-body { overflow-y: auto; padding: 4px 0; flex: 1; }
    .bbt-group-title {
      padding: 6px 10px 2px; font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.04em; color: #666;
    }
    .bbt-group-title.bbt-overdue { color: #b00020; }
    .bbt-group-title.bbt-today { color: #b36b00; }
    .bbt-item {
      display: flex; gap: 8px; padding: 6px 10px; align-items: flex-start;
      border-top: 1px solid #f0f0f0;
    }
    .bbt-item input[type=checkbox] { margin-top: 3px; flex-shrink: 0; }
    .bbt-item-main { flex: 1; min-width: 0; }
    .bbt-item-name { font-weight: 600; text-decoration: none; color: #1a4d8f; display: block;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bbt-item-name:hover { text-decoration: underline; }
    .bbt-item-meta { color: #555; font-size: 12px; display: flex; gap: 6px; flex-wrap: wrap; }
    .bbt-item-course { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    .bbt-item.bbt-done .bbt-item-name { text-decoration: line-through; color: #888; font-weight: 400; }
    .bbt-item.bbt-done .bbt-item-meta { color: #999; }
    .bbt-empty, .bbt-error { padding: 14px 10px; color: #666; text-align: center; }
    .bbt-error { color: #b00020; }
    .bbt-footer {
      padding: 4px 10px; border-top: 1px solid #e5e5e5; font-size: 11px; color: #777;
      display: flex; justify-content: space-between; gap: 8px;
    }
    .bbt-footer .bbt-footer-err { color: #b00020; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `;

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), attrs[k]);
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach((c) => { if (c) node.appendChild(c); });
    return node;
  }

  let root, body, footer, countBadge, courseSelect, showCompletedBox, refreshBtn, collapseBtn;

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const style = el('style', { text: CSS });
    document.head.appendChild(style);

    countBadge = el('span', { class: 'bbt-count', text: '0' });
    refreshBtn = el('button', { class: 'bbt-btn', title: 'Refresh', text: '↻', onclick: () => refresh() });
    collapseBtn = el('button', {
      class: 'bbt-btn', title: 'Collapse / expand', text: '–',
      onclick: () => { state.collapsed = !state.collapsed; Storage.save(state); applyCollapsed(); },
    });

    courseSelect = el('select', {
      onchange: (e) => { state.courseFilter = e.target.value; Storage.save(state); render(); },
    });
    showCompletedBox = el('input', {
      type: 'checkbox',
      onchange: (e) => { state.showCompleted = e.target.checked; Storage.save(state); render(); },
    });

    body = el('div', { class: 'bbt-body' });
    footer = el('div', { class: 'bbt-footer' });

    root = el('div', { id: PANEL_ID }, [
      el('div', { class: 'bbt-header' }, [
        el('span', { class: 'bbt-title', text: 'Assignments' }),
        countBadge, refreshBtn, collapseBtn,
      ]),
      el('div', { class: 'bbt-controls' }, [
        courseSelect,
        el('label', {}, [showCompletedBox, el('span', { text: 'Show done' })]),
      ]),
      body,
      footer,
    ]);
    document.body.appendChild(root);
    applyCollapsed();
  }

  function applyCollapsed() {
    root.classList.toggle('bbt-collapsed', !!state.collapsed);
    collapseBtn.textContent = state.collapsed ? '+' : '–';
  }

  function renderCourseOptions() {
    const seen = new Map();
    items.forEach((it) => { if (!seen.has(it.courseId)) seen.set(it.courseId, it.courseName); });
    const courses = [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    if (state.courseFilter && !seen.has(state.courseFilter)) state.courseFilter = '';
    courseSelect.textContent = '';
    courseSelect.appendChild(el('option', { value: '', text: 'All courses' }));
    courses.forEach(([id, name]) => courseSelect.appendChild(el('option', { value: id, text: name })));
    courseSelect.value = state.courseFilter;
  }

  function renderItem(it) {
    const done = !!state.completed[it.id];
    const cb = el('input', {
      type: 'checkbox', title: done ? 'Mark incomplete' : 'Mark complete',
      onchange: (e) => {
        if (e.target.checked) state.completed[it.id] = true;
        else delete state.completed[it.id];
        Storage.save(state);
        render();
      },
    });
    cb.checked = done;
    const meta = [el('span', { class: 'bbt-item-course', text: it.courseName, title: it.courseName })];
    meta.push(el('span', { text: fmtDue(it.dueAt) }));
    const pts = fmtPoints(it.points);
    if (pts) meta.push(el('span', { text: pts }));
    return el('div', { class: 'bbt-item' + (done ? ' bbt-done' : '') }, [
      cb,
      el('div', { class: 'bbt-item-main' }, [
        el('a', { class: 'bbt-item-name', href: it.url, title: it.name, text: it.name }),
        el('div', { class: 'bbt-item-meta' }, meta),
      ]),
    ]);
  }

  function render() {
    showCompletedBox.checked = !!state.showCompleted;
    renderCourseOptions();

    const now = new Date();
    const visible = visibleItems();
    const open = items.filter((it) => !state.completed[it.id]);
    countBadge.textContent = String(open.length);

    body.textContent = '';
    if (lastError && items.length === 0) {
      body.appendChild(el('div', { class: 'bbt-error', text: "Couldn't load assignments." }));
    } else if (visible.length === 0) {
      body.appendChild(el('div', { class: 'bbt-empty', text: loading ? 'Loading…' : 'Nothing due. 🎉' }));
    } else {
      const groups = groupItems(visible, now);
      BUCKETS.forEach((b) => {
        if (groups[b].length === 0) return;
        const cls = 'bbt-group-title' + (b === 'Overdue' ? ' bbt-overdue' : b === 'Today' ? ' bbt-today' : '');
        body.appendChild(el('div', { class: cls, text: b + ' (' + groups[b].length + ')' }));
        groups[b].forEach((it) => body.appendChild(renderItem(it)));
      });
    }

    footer.textContent = '';
    if (lastError) {
      footer.appendChild(el('span', { class: 'bbt-footer-err', title: lastError, text: 'Error: ' + lastError }));
    } else {
      footer.appendChild(el('span', { text: lastUpdated ? 'Updated ' + lastUpdated.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '' }));
    }
    footer.appendChild(el('span', { text: loading ? 'Refreshing…' : '' }));
    refreshBtn.disabled = loading;
  }

  // ---------------------------------------------------------------------------
  // Refresh loop
  // ---------------------------------------------------------------------------
  async function refresh() {
    if (loading) return;
    loading = true;
    render();
    try {
      const fetched = await DataSource.fetchAssignments();
      // Keep only well-formed items so a partial schema change degrades gracefully.
      items = fetched.filter((it) =>
        it && typeof it.id === 'string' && typeof it.name === 'string' &&
        it.dueAt instanceof Date && !Number.isNaN(it.dueAt.getTime()));
      lastError = null;
      lastUpdated = new Date();
    } catch (e) {
      lastError = (e && e.message) ? e.message : String(e);
      console.warn('[Blackboard TaskBar] refresh failed:', e);
    } finally {
      loading = false;
      render();
    }
  }

  function init() {
    try {
      buildPanel();
      render();
      refresh();
      setInterval(refresh, REFRESH_INTERVAL_MS);
    } catch (e) {
      console.error('[Blackboard TaskBar] failed to initialize:', e);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
