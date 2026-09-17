// ==UserScript==
// @name         Blackboard TaskBar
// @namespace    https://github.com/Rafer374/Blackboard-TaskBar
// @version      0.6.0
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
  const THIS_WEEK_DAYS = 7;                   // List view: "This Week" = due within N days
  const WEEK_STARTS_ON = 0;                   // Week view: 0 = Sunday, 1 = Monday
  const MAX_ATTEMPT_CHECKS = 40;              // cap on per-attempt submission checks
  const STORAGE_KEY = 'bbTaskbar.v1';
  const PANEL_ID = 'bb-taskbar-root';

  // ---------------------------------------------------------------------------
  // Data source adapter
  //
  // Everything Blackboard-specific lives here. fetchAssignments() resolves to
  // an array of normalized items:
  //   { id: string, name: string, courseName: string, courseId: string,
  //     dueAt: Date, points: number|null, url: string,
  //     submitted: boolean, status: string|null }
  //
  // Schema below was taken from real captured responses on an Ultra site.
  // Ultra's own student gradebook page uses exactly these calls:
  //
  //   GET /learn/api/v1/users/me
  //       -> { id: "_123_1", ... }
  //   GET /learn/api/v1/users/{id}/memberships?expand=course.effectiveAvailability,...
  //       -> { results: [{ courseId, course: { id, name, displayName,
  //              effectiveAvailability, isClosed, term: { endDate } } }],
  //            paging: { nextPage } }
  //   GET /learn/api/v1/courses/{courseId}/gradebook/columns?...
  //       -> { results: [{ id, columnName, dueDate, possible, contentId,
  //              scorable, visible, deleted, calculationType,
  //              scoreProviderHandle }] }
  //   GET /learn/api/v1/courses/{courseId}/gradebook/grades?userId={id}&limit=100
  //       -> { results: [{ columnId, status: "NEEDS_GRADING"|"GRADED"|null,
  //              isExempt, effectiveScore, lastAttemptId }] }
  //
  // Every scorable content column with a due date becomes an item. The grade
  // row (if any) decides whether it is already submitted or graded.
  //
  // Ultra pages carry a <base> tag pointing at a CDN, so every URL here is
  // built from location.origin rather than left relative. Internal API calls
  // also need the X-Blackboard-XSRF header, which is read from the page.
  // ---------------------------------------------------------------------------
  const DataSource = {
    origin: location.origin,
    maxCourses: 25,          // safety cap on how many courses to query
    concurrency: 4,          // parallel course fetches
    _xsrf: null,
    _userId: null,

    // Token lives in the page HTML as  xsrf: "<uuid>"  and sometimes in the
    // BbRouter cookie. Try cheap sources first, then refetch the page.
    async xsrfToken() {
      if (this._xsrf) return this._xsrf;
      const re = /xsrf:\s*"?([0-9a-f]{8}-[0-9a-f-]{27})"?/i;
      let m = null;
      try { m = document.cookie.match(/BbRouter=([^;]+)/); m = m && m[1].match(re); } catch (e) { /* ignore */ }
      if (!m) { try { m = document.documentElement.innerHTML.match(re); } catch (e) { /* ignore */ } }
      if (!m) {
        try {
          const res = await fetch(this.origin + '/ultra/institution-page', { credentials: 'include' });
          if (res.ok) m = (await res.text()).match(re);
        } catch (e) { /* ignore */ }
      }
      this._xsrf = m ? m[1] : '';
      return this._xsrf;
    },

    async getJson(path) {
      const xsrf = await this.xsrfToken();
      const res = await fetch(this.origin + path, {
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*', 'X-Blackboard-XSRF': xsrf },
      });
      if (res.status === 401 || res.status === 403) {
        this._xsrf = null; // token may have rotated; refetch next time
        const err = new Error('Not signed in to Blackboard (HTTP ' + res.status + ')');
        err.status = res.status;
        throw err;
      }
      if (!res.ok) throw new Error('Blackboard returned HTTP ' + res.status + ' for ' + path);
      try { return await res.json(); } catch (e) { throw new Error('Response was not JSON for ' + path); }
    },

    async userId() {
      if (this._userId) return this._userId;
      const me = await this.getJson('/learn/api/v1/users/me');
      if (!me || typeof me.id !== 'string') throw new Error('Could not read user id');
      this._userId = me.id;
      return me.id;
    },

    // Courses the user can currently access: [{ id, name }]
    async fetchCourses() {
      const uid = await this.userId();
      const now = Date.now();
      const courses = [];
      let path = '/learn/api/v1/users/' + encodeURIComponent(uid) +
        '/memberships?expand=course.effectiveAvailability,course.permissions,courseRole&includeCount=true&limit=200';
      for (let page = 0; page < 10 && path; page++) {
        const data = await this.getJson(path);
        const results = (data && Array.isArray(data.results)) ? data.results : [];
        results.forEach((m) => {
          const c = m && m.course;
          if (!c || typeof c.id !== 'string') return;
          if (c.effectiveAvailability === false || c.isClosed === true) return;
          if (m.isAvailable === false) return;
          const termEnd = c.term && c.term.endDate ? Date.parse(c.term.endDate) : NaN;
          if (!Number.isNaN(termEnd) && termEnd < now) return;
          courses.push({ id: c.id, name: c.displayName || c.name || c.courseId || c.id });
        });
        const next = data && data.paging && data.paging.nextPage;
        path = (typeof next === 'string' && next && results.length) ? next : null;
      }
      return courses.slice(0, this.maxCourses);
    },

    async fetchCourseGradebook(course, uid) {
      const q = 'isExcludedFromCourseUserActivity=true';
      const [cols, grades] = await Promise.all([
        this.getJson('/learn/api/v1/courses/' + course.id + '/gradebook/columns?' + q +
          '&expand=collectExternalSubmissions&includeInvisible=false'),
        this.getJson('/learn/api/v1/courses/' + course.id + '/gradebook/grades?' + q +
          '&limit=100&userId=' + encodeURIComponent(uid)),
      ]);
      return {
        columns: (cols && Array.isArray(cols.results)) ? cols.results : [],
        grades: (grades && Array.isArray(grades.results)) ? grades.results : [],
      };
    },

    itemUrl(courseId, contentId, handle) {
      const base = this.origin + '/ultra/courses/' + courseId;
      if (!contentId) return base + '/grades';
      if (handle === 'resource/x-bb-assessment' || handle === 'resource/x-bb-asmt-test-link') {
        return base + '/assessment/' + contentId + '/overview?courseId=' + courseId;
      }
      if (handle === 'resource/x-bb-forumlink' || handle === 'resource/x-bb-discussion') {
        return base + '/discussion/' + contentId + '?view=discussions';
      }
      return base + '/grades';
    },

    // Grade-row statuses that mean the student has already turned it in.
    SUBMITTED_STATUSES: { NEEDS_GRADING: 'Submitted', GRADED: 'Graded', COMPLETED: 'Completed' },

    // Attempt statuses that mean "opened or saved, but never turned in".
    // A grade row can say NEEDS_GRADING while the attempt behind it is still a
    // draft, so an ungraded attempt is confirmed against the attempt itself.
    UNSUBMITTED_ATTEMPT_STATUSES: {
      IN_PROGRESS: 1, IN_PROGRESS_AGAIN: 1, NOT_ATTEMPTED: 1, SUSPENDED: 1, DRAFT: 1, CANCELED: 1,
    },

    parseCourse(course, gb) {
      const byColumn = new Map();
      gb.grades.forEach((g) => { if (g && g.columnId) byColumn.set(g.columnId, g); });
      const out = [];
      gb.columns.forEach((c) => {
        try {
          if (!c || typeof c.id !== 'string' || !c.dueDate) return;
          if (c.deleted === true || c.scorable === false || c.visible === false) return;
          if (c.calculationType && c.calculationType !== 'NON_CALCULATED') return;
          if (!c.contentId) return; // manual gradebook-only column, nothing to submit
          const dueAt = new Date(c.dueDate);
          if (Number.isNaN(dueAt.getTime())) return;
          const g = byColumn.get(c.id);
          let status = null;   // null = still open; otherwise a short label
          let verify = null;   // attempt to confirm before trusting the row
          if (g) {
            if (g.isExempt === true) return; // not a task for this student
            const scored = g.effectiveScore !== undefined && g.effectiveScore !== null;
            const attemptId = g.lastAttemptId || g.firstAttemptId || null;
            if (scored) {
              status = 'Graded'; // a score exists, so it was definitely turned in
            } else if (g.status && this.SUBMITTED_STATUSES[g.status]) {
              // No score yet. Only an actual attempt counts as turned in, and
              // whether that attempt was submitted is checked below.
              if (!attemptId) return;
              status = this.SUBMITTED_STATUSES[g.status];
              verify = { attemptId, columnId: c.id };
            }
          }
          const points = typeof c.possible === 'number' ? c.possible : null;
          out.push({
            id: c.id,
            name: c.columnDisplayName || c.effectiveColumnName || c.columnName || '(untitled)',
            courseId: course.id,
            courseName: course.name,
            dueAt,
            points,
            submitted: status !== null,
            status,
            note: null,
            verify,
            url: this.itemUrl(course.id, c.contentId, c.scoreProviderHandle),
          });
        } catch (err) { /* skip unreadable column */ }
      });
      return out;
    },

    // Confirm the ungraded attempts. Blackboard's own attempt record carries
    // the real state: a submitted attempt has a submission timestamp
    // (attemptDate) and a submitted status; a saved draft does not. Anything
    // that fails to load keeps whatever the grade row said.
    async verifyAttempts(list) {
      const queue = list.slice(0, MAX_ATTEMPT_CHECKS);
      const worker = async () => {
        while (queue.length) {
          const it = queue.shift();
          const v = it.verify;
          try {
            const a = await this.getJson('/learn/api/v1/courses/' + it.courseId +
              '/gradebook/attempts/' + encodeURIComponent(v.attemptId) +
              '?columnId=' + encodeURIComponent(v.columnId));
            const turnedIn = !!(a && a.attemptDate) && !this.UNSUBMITTED_ATTEMPT_STATUSES[a && a.status];
            if (!turnedIn) {
              it.submitted = false;
              it.status = null;
              it.note = 'Draft started';
            }
          } catch (e) {
            console.warn('[Blackboard TaskBar] could not verify attempt ' + v.attemptId + ':', e);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));
    },

    async fetchAssignments() {
      const uid = await this.userId();
      const courses = await this.fetchCourses();
      if (courses.length === 0) return [];
      const items = [];
      let failures = 0;
      let lastErr = null;
      const queue = courses.slice();
      const worker = async () => {
        while (queue.length) {
          const course = queue.shift();
          try {
            const gb = await this.fetchCourseGradebook(course, uid);
            items.push(...this.parseCourse(course, gb));
          } catch (e) {
            failures++;
            lastErr = e;
            if (e && (e.status === 401)) throw e; // session gone, stop everything
            console.warn('[Blackboard TaskBar] skipping course ' + course.id + ':', e);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, courses.length) }, worker));
      if (failures === courses.length && lastErr) throw lastErr;
      await this.verifyAttempts(items.filter((it) => it.verify));
      items.forEach((it) => { delete it.verify; });
      return items;
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
    view: 'list',       // 'list' (due-date buckets) or 'week' (one week at a time)
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
  if (state.view !== 'week') state.view = 'list';
  let items = [];            // last successfully fetched, normalized items
  let lastError = null;      // string or null
  let lastUpdated = null;    // Date or null
  let loading = false;
  let weekOffset = 0;        // 0 = this week, +1 next week, -1 last week (not persisted)

  // ---------------------------------------------------------------------------
  // Date helpers, bucketing, week math
  // ---------------------------------------------------------------------------
  const DAY_MS = 24 * 60 * 60 * 1000;
  const BUCKETS = ['Overdue', 'Today', 'Tomorrow', 'This Week', 'Later'];

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  // Start of the week containing `d`, honoring WEEK_STARTS_ON.
  function startOfWeek(d) {
    const x = startOfDay(d);
    const diff = (x.getDay() - WEEK_STARTS_ON + 7) % 7;
    return addDays(x, -diff);
  }

  function bucketFor(dueAt, now) {
    if (dueAt < now) return 'Overdue';
    const diffDays = Math.round((startOfDay(dueAt) - startOfDay(now)) / DAY_MS);
    if (diffDays <= 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    if (diffDays < THIS_WEEK_DAYS) return 'This Week';
    return 'Later';
  }

  function groupByBucket(list, now) {
    const groups = {};
    BUCKETS.forEach((b) => { groups[b] = []; });
    list.forEach((it) => { groups[bucketFor(it.dueAt, now)].push(it); });
    BUCKETS.forEach((b) => groups[b].sort((a, c) => a.dueAt - c.dueAt));
    return BUCKETS.filter((b) => groups[b].length).map((b) => ({ key: b, label: b, items: groups[b] }));
  }

  // One group per day of the selected week, in order.
  function groupByDay(list, weekStart) {
    const groups = [];
    for (let i = 0; i < 7; i++) {
      const dayStart = addDays(weekStart, i);
      const dayEnd = addDays(weekStart, i + 1);
      const dayItems = list.filter((it) => it.dueAt >= dayStart && it.dueAt < dayEnd).sort((a, c) => a.dueAt - c.dueAt);
      if (dayItems.length) {
        const label = dayStart.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
        groups.push({ key: 'day' + i, label, items: dayItems, isToday: startOfDay(new Date()).getTime() === dayStart.getTime() });
      }
    }
    return groups;
  }

  // "Done" = submitted/graded in Blackboard, or checked off by hand.
  function isDone(it) {
    return !!it.submitted || !!state.completed[it.id];
  }

  function courseFilteredItems() {
    return items.filter((it) => !state.courseFilter || it.courseId === state.courseFilter);
  }

  function filteredItems() {
    return courseFilteredItems().filter((it) => state.showCompleted || !isDone(it));
  }

  // Fixed categorical order (validated light-surface palette). Courses are
  // assigned a slot by sorted name so a course keeps its color across reloads.
  const COURSE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

  function courseSlots() {
    const seen = new Map();
    items.forEach((it) => { if (!seen.has(it.courseId)) seen.set(it.courseId, it.courseName); });
    const ordered = [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const slots = new Map();
    ordered.forEach(([id, name], i) => slots.set(id, { name, color: COURSE_COLORS[i % COURSE_COLORS.length], index: i }));
    return slots;
  }

  // Short course label: text before the first ':' or ' - ', e.g. "ME 464".
  function shortCourse(name) {
    const m = String(name).match(/^([^:]{1,14})(?::|\s-\s)/);
    return m ? m[1].trim() : String(name).slice(0, 14);
  }

  // Progress for items due in [start, end): overall and per course.
  function weekProgress(start, end) {
    const inWeek = courseFilteredItems().filter((it) => it.dueAt >= start && it.dueAt < end);
    const perCourse = new Map();
    inWeek.forEach((it) => {
      const c = perCourse.get(it.courseId) || { courseId: it.courseId, name: it.courseName, total: 0, done: 0 };
      c.total++;
      if (isDone(it)) c.done++;
      perCourse.set(it.courseId, c);
    });
    return {
      total: inWeek.length,
      done: inWeek.filter(isDone).length,
      courses: [...perCourse.values()],
    };
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
    return date + ' · ' + fmtTime(d);
  }

  function fmtTime(d) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function fmtWeekRange(weekStart) {
    const end = addDays(weekStart, 6);
    const a = weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const b = end.toLocaleDateString(undefined, weekStart.getMonth() === end.getMonth()
      ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
    return a + ' – ' + b;
  }

  function fmtPoints(p) {
    if (p === null || p === undefined || Number.isNaN(p)) return '';
    return (Number.isInteger(p) ? p : p.toFixed(2)) + ' pts';
  }

  // ---------------------------------------------------------------------------
  // UI. Everything lives inside a shadow root so Blackboard's own stylesheet
  // (which hides native checkboxes, restyles labels, etc.) can't touch it.
  // ---------------------------------------------------------------------------
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .bbt-panel {
      position: fixed; top: 64px; right: 12px; z-index: 2147483000;
      width: 340px; max-height: calc(100vh - 80px);
      display: flex; flex-direction: column;
      background: #fff; color: #222;
      border: 1px solid #d0d0d0; border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.18);
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .bbt-header {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; border-bottom: 1px solid #e5e5e5;
      background: #f7f7f7; border-radius: 8px 8px 0 0;
    }
    .bbt-title { font-weight: 600; flex: 1; white-space: nowrap; }
    .bbt-count {
      background: #2b5797; color: #fff; border-radius: 10px;
      padding: 0 7px; font-size: 11px; font-weight: 600; line-height: 18px;
    }
    .bbt-btn {
      border: 1px solid #ccc; background: #fff; border-radius: 4px; color: #222;
      padding: 2px 8px; cursor: pointer; font: inherit; line-height: 1.3;
    }
    .bbt-btn:hover { background: #eee; }
    .bbt-btn:disabled { opacity: 0.5; cursor: default; }
    .bbt-btn.bbt-active { background: #2b5797; color: #fff; border-color: #2b5797; }
    .bbt-controls {
      display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      padding: 6px 10px; border-bottom: 1px solid #e5e5e5;
    }
    .bbt-controls select {
      flex: 1; min-width: 120px; font: inherit; padding: 3px 4px;
      border: 1px solid #ccc; border-radius: 4px; background: #fff; color: #222;
    }
    .bbt-toggle { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; white-space: nowrap; user-select: none; }
    .bbt-toggle input { appearance: auto; width: 14px; height: 14px; margin: 0; cursor: pointer; }
    .bbt-seg { display: inline-flex; }
    .bbt-seg .bbt-btn { border-radius: 0; margin-left: -1px; }
    .bbt-seg .bbt-btn:first-child { border-radius: 4px 0 0 4px; margin-left: 0; }
    .bbt-seg .bbt-btn:last-child { border-radius: 0 4px 4px 0; }
    .bbt-weeknav {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 10px; border-bottom: 1px solid #e5e5e5; background: #fafafa;
    }
    .bbt-weeknav .bbt-range { flex: 1; text-align: center; font-weight: 600; cursor: pointer; }
    .bbt-weeknav .bbt-range:hover { text-decoration: underline; }
    .bbt-weeknav .bbt-range small { display: block; font-weight: 400; color: #666; font-size: 11px; }
    .bbt-progress {
      display: flex; align-items: center; gap: 12px;
      padding: 8px 10px; border-bottom: 1px solid #e5e5e5;
    }
    .bbt-progress svg { flex-shrink: 0; display: block; }
    .bbt-ring-track { fill: none; stroke: #ececec; }
    .bbt-ring-fill { fill: none; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 50% 50%; }
    .bbt-ring-pct { font-size: 16px; font-weight: 700; fill: #222; }
    .bbt-ring-sub { font-size: 9px; fill: #666; }
    .bbt-legend { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
    .bbt-legend-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #666; margin-bottom: 2px; }
    .bbt-legend-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .bbt-legend-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
    .bbt-legend-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #333; }
    .bbt-legend-count { color: #666; font-variant-numeric: tabular-nums; }
    .bbt-legend-empty { color: #888; font-size: 12px; }
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
    .bbt-item input { appearance: auto; width: 15px; height: 15px; margin: 3px 0 0; flex-shrink: 0; cursor: pointer; }
    .bbt-item-main { flex: 1; min-width: 0; }
    .bbt-item-name { font-weight: 600; text-decoration: none; color: #1a4d8f; display: block;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bbt-item-name:hover { text-decoration: underline; }
    .bbt-item-meta { color: #555; font-size: 12px; display: flex; gap: 6px; flex-wrap: wrap; }
    .bbt-item-course { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    .bbt-item.bbt-done .bbt-item-name { text-decoration: line-through; color: #888; font-weight: 400; }
    .bbt-item.bbt-done .bbt-item-meta { color: #999; }
    .bbt-item-status {
      background: #e6f2ea; color: #1d6b3a; border-radius: 3px; padding: 0 5px;
      font-size: 11px; font-weight: 600;
    }
    .bbt-item-note {
      background: #fdf0d9; color: #8a5a00; border-radius: 3px; padding: 0 5px;
      font-size: 11px; font-weight: 600;
    }
    .bbt-empty, .bbt-error { padding: 14px 10px; color: #666; text-align: center; }
    .bbt-error { color: #b00020; }
    .bbt-footer {
      padding: 4px 10px; border-top: 1px solid #e5e5e5; font-size: 11px; color: #777;
      display: flex; justify-content: space-between; gap: 8px;
    }
    .bbt-footer .bbt-footer-err { color: #b00020; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Collapsed: a vertical tab hugging the right edge of the window. */
    .bbt-tab {
      position: fixed; right: 0; top: 35%; z-index: 2147483000;
      display: none; align-items: center; gap: 8px;
      writing-mode: vertical-rl; transform: rotate(180deg);
      padding: 12px 7px; background: #2b5797; color: #fff;
      border-radius: 0 8px 8px 0; box-shadow: 0 2px 10px rgba(0,0,0,0.25);
      font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      cursor: pointer; user-select: none; letter-spacing: 0.02em;
    }
    .bbt-tab:hover { background: #1f4477; }
    .bbt-tab .bbt-count { background: #fff; color: #2b5797; writing-mode: horizontal-tb; transform: rotate(180deg); }
    .bbt-collapsed .bbt-panel { display: none; }
    .bbt-collapsed .bbt-tab { display: flex; }
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

  let host, wrap, body, footer, countBadge, tabBadge, courseSelect, showCompletedBox;
  let refreshBtn, listBtn, weekBtn, weekNav, weekRange, progressBox;

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;
    host = el('div', { id: PANEL_ID });
    const shadow = host.attachShadow({ mode: 'open' });

    countBadge = el('span', { class: 'bbt-count', text: '0' });
    tabBadge = el('span', { class: 'bbt-count', text: '0' });
    refreshBtn = el('button', { class: 'bbt-btn', title: 'Refresh', text: '↻', onclick: () => refresh() });
    const collapseBtn = el('button', { class: 'bbt-btn', title: 'Collapse', text: '–', onclick: () => setCollapsed(true) });

    courseSelect = el('select', {
      onchange: (e) => { state.courseFilter = e.target.value; Storage.save(state); render(); },
    });
    showCompletedBox = el('input', {
      type: 'checkbox',
      onchange: (e) => { state.showCompleted = e.target.checked; Storage.save(state); render(); },
    });
    listBtn = el('button', { class: 'bbt-btn', text: 'List', title: 'Group by due date', onclick: () => setView('list') });
    weekBtn = el('button', { class: 'bbt-btn', text: 'Week', title: 'One week at a time', onclick: () => setView('week') });

    weekRange = el('span', { class: 'bbt-range', title: 'Back to this week', onclick: () => { weekOffset = 0; render(); } });
    weekNav = el('div', { class: 'bbt-weeknav' }, [
      el('button', { class: 'bbt-btn', text: '‹', title: 'Previous week', onclick: () => { weekOffset--; render(); } }),
      weekRange,
      el('button', { class: 'bbt-btn', text: '›', title: 'Next week', onclick: () => { weekOffset++; render(); } }),
    ]);

    body = el('div', { class: 'bbt-body' });
    footer = el('div', { class: 'bbt-footer' });
    progressBox = el('div', { class: 'bbt-progress' });

    const panel = el('div', { class: 'bbt-panel' }, [
      el('div', { class: 'bbt-header' }, [
        el('span', { class: 'bbt-title', text: 'Assignments' }),
        countBadge, refreshBtn, collapseBtn,
      ]),
      el('div', { class: 'bbt-controls' }, [
        el('span', { class: 'bbt-seg' }, [listBtn, weekBtn]),
        courseSelect,
        el('label', { class: 'bbt-toggle' }, [showCompletedBox, el('span', { text: 'Show done' })]),
      ]),
      weekNav,
      progressBox,
      body,
      footer,
    ]);
    const tab = el('div', { class: 'bbt-tab', title: 'Open assignments', onclick: () => setCollapsed(false) }, [
      el('span', { text: 'Assignments' }), tabBadge,
    ]);

    wrap = el('div', {}, [el('style', { text: CSS }), panel, tab]);
    shadow.appendChild(wrap);
    (document.body || document.documentElement).appendChild(host);
    applyCollapsed();
  }

  // Ultra is a single-page app that can replace large parts of the DOM after
  // load. If our panel gets detached, put it back.
  function watchdog() {
    if (host && !document.getElementById(PANEL_ID)) {
      console.info('[Blackboard TaskBar] panel was removed by the page, re-attaching');
      (document.body || document.documentElement).appendChild(host);
    }
  }

  function setCollapsed(v) {
    state.collapsed = !!v;
    Storage.save(state);
    applyCollapsed();
  }

  function applyCollapsed() {
    wrap.classList.toggle('bbt-collapsed', !!state.collapsed);
  }

  function setView(v) {
    state.view = v;
    weekOffset = 0;
    Storage.save(state);
    render();
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

  function renderItem(it, timeOnly) {
    const done = isDone(it);
    const cb = el('input', {
      type: 'checkbox',
      title: it.submitted ? (it.status + ' in Blackboard') : (done ? 'Mark incomplete' : 'Mark complete'),
      onchange: (e) => {
        if (e.target.checked) state.completed[it.id] = true;
        else delete state.completed[it.id];
        Storage.save(state);
        render();
      },
    });
    cb.checked = done;
    cb.disabled = !!it.submitted; // Blackboard's state wins; nothing to toggle
    const meta = [el('span', { class: 'bbt-item-course', text: it.courseName, title: it.courseName })];
    meta.push(el('span', { text: timeOnly ? fmtTime(it.dueAt) : fmtDue(it.dueAt) }));
    const pts = fmtPoints(it.points);
    if (pts) meta.push(el('span', { text: pts }));
    if (it.submitted) meta.push(el('span', { class: 'bbt-item-status', text: it.status }));
    else if (it.note) meta.push(el('span', { class: 'bbt-item-note', title: 'Started but not submitted', text: it.note }));
    return el('div', { class: 'bbt-item' + (done ? ' bbt-done' : '') }, [
      cb,
      el('div', { class: 'bbt-item-main' }, [
        el('a', { class: 'bbt-item-name', href: it.url, title: it.name, text: it.name }),
        el('div', { class: 'bbt-item-meta' }, meta),
      ]),
    ]);
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, attrs[k]));
    return n;
  }

  // Concentric rings: outer = all courses combined, inner = one per course
  // (fixed color per course, legend alongside so color is never the only cue).
  function renderProgress(start, end, label) {
    const prog = weekProgress(start, end);
    const slots = courseSlots();
    const rings = prog.courses
      .map((c) => ({ ...c, slot: slots.get(c.courseId) }))
      .sort((a, b) => a.slot.index - b.slot.index)
      .slice(0, COURSE_COLORS.length);

    const size = 104, cx = size / 2, cy = size / 2;
    const MIN_R = 22; // keep inner rings clear of the center text
    const svg = svgEl('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size, role: 'img',
      'aria-label': prog.done + ' of ' + prog.total + ' complete' });
    const ringSpecs = [{ r: 47, w: 6, color: '#2b5797', done: prog.done, total: prog.total }];
    rings.forEach((c, i) => ringSpecs.push({ r: 47 - 7 * (i + 1), w: 4, color: c.slot.color, done: c.done, total: c.total }));
    ringSpecs.forEach((rs) => {
      if (rs.r < MIN_R) return; // legend still lists the course
      const circ = 2 * Math.PI * rs.r;
      svg.appendChild(svgEl('circle', { class: 'bbt-ring-track', cx, cy, r: rs.r, 'stroke-width': rs.w }));
      const frac = rs.total ? rs.done / rs.total : 0;
      if (frac > 0) {
        svg.appendChild(svgEl('circle', { class: 'bbt-ring-fill', cx, cy, r: rs.r, 'stroke-width': rs.w, stroke: rs.color,
          'stroke-dasharray': (circ * frac) + ' ' + circ }));
      }
    });
    const pct = prog.total ? Math.round(100 * prog.done / prog.total) : 0;
    const t1 = svgEl('text', { class: 'bbt-ring-pct', x: cx, y: cy - 1, 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
    t1.textContent = pct + '%';
    const t2 = svgEl('text', { class: 'bbt-ring-sub', x: cx, y: cy + 12, 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
    t2.textContent = prog.done + '/' + prog.total + ' done';
    svg.appendChild(t1); svg.appendChild(t2);

    const legend = el('div', { class: 'bbt-legend' }, [el('div', { class: 'bbt-legend-title', text: label })]);
    if (!rings.length) legend.appendChild(el('div', { class: 'bbt-legend-empty', text: 'Nothing due.' }));
    rings.forEach((c) => {
      const dot = el('span', { class: 'bbt-legend-dot' }); dot.style.background = c.slot.color;
      legend.appendChild(el('div', { class: 'bbt-legend-row', title: c.name }, [
        dot,
        el('span', { class: 'bbt-legend-name', text: shortCourse(c.name) }),
        el('span', { class: 'bbt-legend-count', text: c.done + '/' + c.total }),
      ]));
    });

    progressBox.textContent = '';
    progressBox.appendChild(svg);
    progressBox.appendChild(legend);
    return prog;
  }

  function render() {
    showCompletedBox.checked = !!state.showCompleted;
    listBtn.classList.toggle('bbt-active', state.view === 'list');
    weekBtn.classList.toggle('bbt-active', state.view === 'week');
    renderCourseOptions();

    const now = new Date();
    const visible = filteredItems();

    let groups, emptyMsg, timeOnly = false, prog = null, progLabel = '';
    if (state.view === 'week') {
      const weekStart = addDays(startOfWeek(now), 7 * weekOffset);
      const weekEnd = addDays(weekStart, 7);
      weekNav.style.display = '';
      weekRange.textContent = '';
      weekRange.appendChild(document.createTextNode(fmtWeekRange(weekStart)));
      weekRange.appendChild(el('small', { text: weekOffset === 0 ? 'This week' : weekOffset === 1 ? 'Next week' : weekOffset === -1 ? 'Last week' : (weekOffset > 0 ? weekOffset + ' weeks ahead' : (-weekOffset) + ' weeks ago') }));
      groups = groupByDay(visible.filter((it) => it.dueAt >= weekStart && it.dueAt < weekEnd), weekStart);
      emptyMsg = 'Nothing due this week.';
      timeOnly = true;
      progLabel = weekOffset === 0 ? 'this week' : fmtWeekRange(weekStart);
      prog = renderProgress(weekStart, weekEnd, weekOffset === 0 ? 'This week' : fmtWeekRange(weekStart));
    } else {
      weekNav.style.display = 'none';
      groups = groupByBucket(visible, now);
      emptyMsg = items.length && !visible.length ? 'All caught up. 🎉' : 'Nothing due. 🎉';
      const ws = startOfWeek(now);
      progLabel = 'this week';
      prog = renderProgress(ws, addDays(ws, 7), 'This week');
    }

    // The badge counts what is still left in the week being shown, not the
    // whole term, so the collapsed tab answers "what do I owe this week?".
    const weekLeft = prog ? prog.total - prog.done : 0;
    countBadge.textContent = String(weekLeft);
    tabBadge.textContent = String(weekLeft);
    const badgeTitle = weekLeft + (weekLeft === 1 ? ' assignment' : ' assignments') + ' left ' +
      (progLabel === 'this week' ? 'this week' : 'in ' + progLabel);
    countBadge.setAttribute('title', badgeTitle);
    tabBadge.setAttribute('title', badgeTitle);

    body.textContent = '';
    if (lastError && items.length === 0) {
      body.appendChild(el('div', { class: 'bbt-error', text: "Couldn't load assignments." }));
    } else if (groups.length === 0) {
      body.appendChild(el('div', { class: 'bbt-empty', text: loading ? 'Loading…' : emptyMsg }));
    } else {
      groups.forEach((g) => {
        const cls = 'bbt-group-title' + (g.key === 'Overdue' ? ' bbt-overdue' : (g.key === 'Today' || g.isToday) ? ' bbt-today' : '');
        body.appendChild(el('div', { class: cls, text: g.label + ' (' + g.items.length + ')' }));
        g.items.forEach((it) => body.appendChild(renderItem(it, timeOnly)));
      });
    }

    footer.textContent = '';
    if (lastError) {
      footer.appendChild(el('span', { class: 'bbt-footer-err', title: lastError, text: 'Error: ' + lastError }));
    } else {
      footer.appendChild(el('span', { text: lastUpdated ? 'Updated ' + fmtTime(lastUpdated) : '' }));
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
    console.info('[Blackboard TaskBar] loaded on ' + location.href);
    try {
      buildPanel();
      render();
      refresh();
      setInterval(refresh, REFRESH_INTERVAL_MS);
      setInterval(watchdog, 2000);
    } catch (e) {
      console.error('[Blackboard TaskBar] failed to initialize:', e);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
