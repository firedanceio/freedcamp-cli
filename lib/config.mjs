// Copyright 2026 Firedance Multimedia LLC
// SPDX-License-Identifier: Apache-2.0
// @ts-check
/* eslint-disable no-console */

/**
 * Loads Freedcamp credentials + project config from the environment.
 *
 * Everything is read from `process.env`. For local use a dotenv-style file
 * (`.env.freedcamp`, then `.env`, in the current directory) can be sourced
 * first with `loadDotenvInto()`; values already in the environment win.
 * Keep those files out of git.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * @typedef {Object} FreedcampConfig
 * @property {string}      apiKey       Freedcamp API key.
 * @property {string|null} apiSecret    API secret (secured keys). null → unsecured key.
 * @property {string}      baseUrl      API base, default https://freedcamp.com/api/v1
 * @property {string|null} projectId    Default project id for task ops.
 * @property {string|null} listId       Default task-list id for new tasks.
 */

const DEFAULT_BASE_URL = 'https://freedcamp.com/api/v1';

/**
 * Read and validate Freedcamp config from the environment.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {FreedcampConfig}
 */
export function loadConfig(env = process.env) {
  const apiKey = (env.FREEDCAMP_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new ConfigError(
      'FREEDCAMP_API_KEY is not set. Generate one at Freedcamp → My Account → Integrations → API, ' +
        'then export it or add it to .env.freedcamp.',
    );
  }

  const apiSecretRaw = (env.FREEDCAMP_API_SECRET ?? '').trim();
  const apiSecret = apiSecretRaw === '' ? null : apiSecretRaw;

  const baseUrlRaw = (env.FREEDCAMP_BASE_URL ?? '').trim();
  const baseUrl = (baseUrlRaw === '' ? DEFAULT_BASE_URL : baseUrlRaw).replace(/\/+$/, '');

  const projectId = normalizeId(env.FREEDCAMP_PROJECT_ID);
  const listId = normalizeId(env.FREEDCAMP_LIST_ID);

  return { apiKey, apiSecret, baseUrl, projectId, listId };
}

/**
 * @param {string|undefined} raw
 * @returns {string|null}
 */
function normalizeId(raw) {
  const v = (raw ?? '').trim();
  return v === '' ? null : v;
}

/**
 * Minimal dotenv loader. Merges `KEY=VALUE` lines from `path` into
 * `target` WITHOUT overriding values already present (real env wins).
 * Supports quoted values and `\n` unescaping.
 *
 * @param {string} path
 * @param {NodeJS.ProcessEnv} [target]
 * @returns {boolean} true if the file existed and was read
 */
export function loadDotenvInto(path, target = process.env) {
  const abs = resolve(path);
  if (!existsSync(abs)) return false;
  const text = readFileSync(abs, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (target[key] !== undefined && target[key] !== '') continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
      if (value.includes('\\n')) value = value.replace(/\\n/g, '\n');
    }
    target[key] = value;
  }
  return true;
}

/** Thrown when required configuration is missing or malformed. */
export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}
