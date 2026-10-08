// Copyright 2026 Firedance Multimedia LLC
// SPDX-License-Identifier: Apache-2.0
// @ts-check
/* eslint-disable no-console */

/**
 * Thin Freedcamp public API client.
 *
 * API docs: https://freedcamp.com/api/v1/  (Freedcamp Public API wiki).
 *
 * Auth: for a "secured" key we send `api_key`, `timestamp` (Unix seconds)
 * and `hash = HMAC-SHA1(api_key + timestamp, api_secret)` as GET params.
 * For an "unsecured" key only `api_key` is needed. The api_key is also
 * sent via the `X-API-KEY` header so it never lands in a body/log line.
 *
 * Non-GET bodies are raw JSON with `Content-Type: application/json`.
 *
 * Every response is a `{ http_code, msg, error_id, data }` envelope; we
 * unwrap `data` and throw `FreedcampApiError` on non-2xx `http_code`.
 */

import { createHmac } from 'node:crypto';

/**
 * @typedef {import('./config.mjs').FreedcampConfig} FreedcampConfig
 */

export class FreedcampClient {
  /** @param {FreedcampConfig} config */
  constructor(config) {
    /** @type {FreedcampConfig} */
    this.config = config;
  }

  // ---- Projects ---------------------------------------------------------

  /** List projects the key can access. @returns {Promise<any>} */
  async listProjects() {
    return this.#request('GET', '/projects');
  }

  // ---- Milestones (feature / epic containers) ---------------------------

  /**
   * List milestones in a project. Milestones are the feature/epic-level
   * container; per-slice tasks link to one via `ms_id`.
   * @param {string} projectId
   * @returns {Promise<any>}
   */
  async listMilestones(projectId) {
    return this.#request('GET', `/milestones?project_id=${encodeURIComponent(projectId)}`);
  }

  /**
   * Create a milestone (feature/epic). Freedcamp requires `due_date` and
   * `priority`; verified available on the free plan.
   * @param {{
   *   title: string,
   *   projectId: string,
   *   dueDate: string,
   *   priority?: number|string,
   *   description?: string,
   *   assignedToId?: number|string,
   * }} input
   * @returns {Promise<any>}
   */
  async createMilestone(input) {
    if (!input.title) throw new TypeError('createMilestone: title is required');
    if (!input.projectId) throw new TypeError('createMilestone: projectId is required');
    if (!input.dueDate) throw new TypeError('createMilestone: dueDate is required');
    /** @type {Record<string, unknown>} */
    const body = {
      project_id: String(input.projectId),
      title: input.title,
      due_date: input.dueDate,
      priority: input.priority != null ? Number(input.priority) : 2,
      status: 0,
    };
    if (input.description != null) body.description = input.description;
    if (input.assignedToId != null) body.assigned_to_id = String(input.assignedToId);
    return this.#request('POST', '/milestones', body);
  }

  /**
   * Set a milestone's status. `0` active, `1` completed.
   * @param {string} milestoneId
   * @param {0|1} status
   * @returns {Promise<any>}
   */
  async setMilestoneStatus(milestoneId, status) {
    if (!milestoneId) throw new TypeError('setMilestoneStatus: milestoneId is required');
    return this.#request('POST', `/milestones/${encodeURIComponent(milestoneId)}`, {
      status,
    });
  }

  // ---- Task lists -------------------------------------------------------

  /**
   * List the distinct task lists (groups) used in a project. Freedcamp's
   * public API has no standalone "task lists" endpoint (the Task Lists app
   * is not exposed), so we derive them from the tasks in the project.
   * @param {string} projectId
   * @returns {Promise<Array<{ id: string, title: string, archived: boolean }>>}
   */
  async listTaskLists(projectId) {
    const data = await this.listTasks({ projectId, limit: 200 });
    const tasks = data?.tasks ?? (Array.isArray(data) ? data : []);
    /** @type {Map<string, { id: string, title: string, archived: boolean }>} */
    const byId = new Map();
    for (const t of tasks) {
      const id = String(t.list_id ?? t.task_group_id ?? '');
      if (!id || byId.has(id)) continue;
      byId.set(id, {
        id,
        title: t.list_title ?? t.task_group_name ?? '',
        archived: Boolean(t.f_archived_list),
      });
    }
    return [...byId.values()];
  }

  // ---- Tasks ------------------------------------------------------------

  /**
   * List tasks, optionally scoped to a project. Supports Freedcamp's
   * filter params (status[], assigned_to_id[], due_date[from], ...) via
   * `extraQuery`.
   * @param {{ projectId?: string|null, limit?: number, offset?: number, extraQuery?: string }} [opts]
   * @returns {Promise<any>}
   */
  async listTasks(opts = {}) {
    const params = new URLSearchParams();
    if (opts.projectId) params.set('project_id', String(opts.projectId));
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.offset != null) params.set('offset', String(opts.offset));
    let path = '/tasks';
    const qs = params.toString();
    if (qs) path += `?${qs}`;
    if (opts.extraQuery) path += (qs ? '&' : '?') + opts.extraQuery.replace(/^[?&]/, '');
    return this.#request('GET', path);
  }

  /**
   * Fetch a single task by id (includes description_processed, comments, files).
   * @param {string} taskId
   * @returns {Promise<any>}
   */
  async getTask(taskId) {
    return this.#request('GET', `/tasks/${encodeURIComponent(taskId)}`);
  }

  /**
   * Create a task.
   * @param {{
   *   title: string,
   *   projectId: string,
   *   description?: string,
   *   listId?: string|null,
   *   priority?: number|string,
   *   assignedToId?: number|string,
   *   dueDate?: string,
   *   startDate?: string,
   *   msId?: string|null,
   * }} input
   * @returns {Promise<any>}
   */
  async createTask(input) {
    if (!input.title) throw new TypeError('createTask: title is required');
    if (!input.projectId) throw new TypeError('createTask: projectId is required');
    /** @type {Record<string, unknown>} */
    const body = { title: input.title, project_id: String(input.projectId) };
    if (input.description != null) body.description = input.description;
    if (input.listId) body.list_id = String(input.listId);
    if (input.priority != null) body.priority = String(input.priority);
    if (input.assignedToId != null) body.assigned_to_id = String(input.assignedToId);
    if (input.dueDate) body.due_date = input.dueDate;
    if (input.startDate) body.start_date = input.startDate;
    if (input.msId) body.ms_id = String(input.msId);
    return this.#request('POST', '/tasks', body);
  }

  /**
   * Edit a task. Pass only the fields you want to change.
   * `status` maps to Freedcamp status ids (0 = not started, 1 = completed,
   * 2 = in progress) — see the Freedcamp Constants wiki.
   * @param {string} taskId
   * @param {Record<string, unknown>} patch
   * @returns {Promise<any>}
   */
  async updateTask(taskId, patch) {
    if (!taskId) throw new TypeError('updateTask: taskId is required');
    return this.#request('POST', `/tasks/${encodeURIComponent(taskId)}`, patch);
  }

  /**
   * Convenience: set a task's status.
   * @param {string} taskId
   * @param {0|1|2} status
   * @returns {Promise<any>}
   */
  async setTaskStatus(taskId, status) {
    return this.updateTask(taskId, { status: String(status) });
  }

  /**
   * Delete a task.
   * @param {string} taskId
   * @returns {Promise<any>}
   */
  async deleteTask(taskId) {
    if (!taskId) throw new TypeError('deleteTask: taskId is required');
    return this.#request('DELETE', `/tasks/${encodeURIComponent(taskId)}`);
  }

  // ---- Comments ---------------------------------------------------------

  /**
   * Add a comment to any item (e.g. a task). `app_id` is the Freedcamp
   * application id for tasks (2); `item_id` is the task id.
   * @param {{ itemId: string, appId?: number|string, description: string }} input
   * @returns {Promise<any>}
   */
  async addComment(input) {
    if (!input.itemId) throw new TypeError('addComment: itemId is required');
    if (!input.description) throw new TypeError('addComment: description is required');
    return this.#request('POST', '/comments', {
      app_id: String(input.appId ?? 2),
      item_id: String(input.itemId),
      description: input.description,
    });
  }

  // ---- Session (auth check) --------------------------------------------

  /** Verify credentials by fetching the current session. @returns {Promise<any>} */
  async currentSession() {
    return this.#request('GET', '/sessions/current');
  }

  // ---- Internals --------------------------------------------------------

  /**
   * Compute the signed query string for the request.
   * @returns {string}
   */
  #authQuery() {
    const { apiKey, apiSecret } = this.config;
    const params = new URLSearchParams({ api_key: apiKey });
    if (apiSecret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const hash = createHmac('sha1', apiSecret)
        .update(apiKey + timestamp)
        .digest('hex');
      params.set('timestamp', timestamp);
      params.set('hash', hash);
    }
    return params.toString();
  }

  /**
   * @param {'GET'|'POST'|'DELETE'} method
   * @param {string} path e.g. `/tasks?project_id=1`
   * @param {Record<string, unknown>} [body]
   * @returns {Promise<any>}
   */
  async #request(method, path, body) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${this.config.baseUrl}${path}${sep}${this.#authQuery()}`;

    /** @type {Record<string, string>} */
    const headers = {
      Accept: 'application/json',
      // Also send the key via header so it isn't the sole thing on the URL.
      'X-API-KEY': this.config.apiKey,
    };
    /** @type {RequestInit} */
    const init = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(url, init);
    } catch (cause) {
      throw new FreedcampApiError(`Network error calling ${method} ${path}`, {
        cause: /** @type {Error} */ (cause),
      });
    }

    const text = await res.text();
    /** @type {any} */
    let envelope;
    try {
      envelope = text ? JSON.parse(text) : {};
    } catch {
      throw new FreedcampApiError(
        `Non-JSON response (HTTP ${res.status}) from ${method} ${path}: ${truncate(text)}`,
        { httpStatus: res.status },
      );
    }

    const httpCode = Number(envelope.http_code ?? res.status);
    if (httpCode < 200 || httpCode >= 300) {
      const errors = envelope?.data?.errors;
      throw new FreedcampApiError(
        `${method} ${path} failed: ${envelope.msg ?? 'Unknown error'} (http_code ${httpCode})`,
        { httpStatus: httpCode, errorId: envelope.error_id, errors },
      );
    }

    return envelope.data;
  }
}

/** @param {string} s */
function truncate(s) {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/** Error carrying Freedcamp's structured failure info. */
export class FreedcampApiError extends Error {
  /**
   * @param {string} message
   * @param {{ httpStatus?: number, errorId?: number, errors?: unknown, cause?: Error }} [meta]
   */
  constructor(message, meta = {}) {
    super(message, meta.cause ? { cause: meta.cause } : undefined);
    this.name = 'FreedcampApiError';
    this.httpStatus = meta.httpStatus;
    this.errorId = meta.errorId;
    this.errors = meta.errors;
  }
}
