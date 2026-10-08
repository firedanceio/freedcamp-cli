#!/usr/bin/env node
// Copyright 2026 Firedance Multimedia LLC
// SPDX-License-Identifier: Apache-2.0
// @ts-check
/* eslint-disable no-console */

/**
 * Freedcamp CLI: drive projects, milestones and tasks from the terminal or a
 * script (or an AI coding agent, with --json).
 *
 *   freedcamp <command> [options]
 *
 * Commands:
 *   whoami                         Verify credentials (current session).
 *   projects                       List accessible projects.
 *   lists [--project <id>]         List task lists for a project.
 *   tasks  [--project <id>] [--limit n] [--offset n] [--status s]
 *                                  List tasks (defaults to FREEDCAMP_PROJECT_ID).
 *   task   <taskId>                Show one task (with comments/files).
 *   create --title <t> [--desc d] [--project id] [--list id]
 *          [--priority n] [--assignee id] [--due YYYY-MM-DD]
 *   update <taskId> [--title t] [--desc d] [--priority n]
 *          [--assignee id] [--due YYYY-MM-DD] [--status 0|1|2]
 *   status <taskId> <todo|doing|done>
 *   comment <taskId> --body "<text>"
 *   delete <taskId>                Delete a task (asks unless --yes).
 *
 * Global options:
 *   --json      Emit raw JSON (for agent consumption).
 *   --yes       Skip confirmation prompts.
 *   --env-file  Path to a dotenv file (default: .env.freedcamp then .env in the current directory).
 *
 * Credentials come from the environment (see README.md):
 *   FREEDCAMP_API_KEY (required), FREEDCAMP_API_SECRET (secured keys),
 *   FREEDCAMP_PROJECT_ID / FREEDCAMP_LIST_ID (defaults), FREEDCAMP_BASE_URL.
 */

import { resolve } from 'node:path';
import { loadConfig, loadDotenvInto, ConfigError } from '../lib/config.mjs';
import { FreedcampClient, FreedcampApiError } from '../lib/client.mjs';

/** Map friendly status names → Freedcamp status ids. */
const STATUS = /** @type {const} */ ({ todo: 0, doing: 2, done: 1 });

main().catch((err) => {
  fail(err);
});

async function main() {
  const argv = process.argv.slice(2);
  const { command, positionals, flags } = parseArgs(argv);

  if (!command || command === 'help' || flags.help) {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  // Bootstrap env from a dotenv file (real env always wins).
  const explicitEnvFile = typeof flags['env-file'] === 'string' ? flags['env-file'] : null;
  if (explicitEnvFile) {
    if (!loadDotenvInto(explicitEnvFile))
      fail(new Error(`--env-file not found: ${explicitEnvFile}`));
  } else {
    loadDotenvInto(resolve('.env.freedcamp'));
    loadDotenvInto(resolve('.env'));
  }

  const config = loadConfig();
  const client = new FreedcampClient(config);
  const asJson = Boolean(flags.json);

  switch (command) {
    case 'whoami': {
      const data = await client.currentSession();
      return output(asJson, data, () => 'Credentials OK — session is valid.');
    }

    case 'projects': {
      const data = await client.listProjects();
      const projects = data?.projects ?? data;
      return output(asJson, projects, () => formatProjects(projects));
    }

    case 'milestones': {
      const projectId = str(flags.project) ?? config.projectId;
      requireProject(projectId, 'milestones');
      const data = await client.listMilestones(projectId);
      const ms = data?.milestones ?? data;
      return output(asJson, ms, () =>
        Array.isArray(ms) && ms.length
          ? ms
              .map(
                (m) =>
                  `${m.id}\t[${m.status === '1' || m.status === 1 ? 'done' : 'active'}]\t${m.title ?? ''}`,
              )
              .join('\n')
          : '(no milestones)',
      );
    }

    case 'milestone-create': {
      const title = str(flags.title);
      if (!title) fail(new Error('milestone-create: --title is required'));
      const dueDate = str(flags.due);
      if (!dueDate) fail(new Error('milestone-create: --due <YYYY-MM-DD> is required'));
      const projectId = str(flags.project) ?? config.projectId;
      requireProject(projectId, 'milestone-create');
      const data = await client.createMilestone({
        title,
        projectId,
        dueDate,
        priority: num(flags.priority) ?? 2,
        description: str(flags.desc) ?? str(flags.description),
        assignedToId: str(flags.assignee),
      });
      const m = (data?.milestones && data.milestones[0]) ?? data;
      return output(asJson, m, () => `Created milestone ${m?.id} (${m?.title ?? ''})`);
    }

    case 'milestone-status': {
      const milestoneId = requireId(positionals[0], 'milestone-status <milestoneId> <active|done>');
      const name = String(positionals[1] ?? '').toLowerCase();
      const map = { active: 0, done: 1 };
      if (!(name in map))
        fail(new Error(`milestone-status: expected active|done, got "${positionals[1]}"`));
      const data = await client.setMilestoneStatus(
        milestoneId,
        map[/** @type {'active'|'done'} */ (name)],
      );
      return output(asJson, data, () => `Milestone ${milestoneId} → ${name}`);
    }

    case 'lists': {
      const projectId = str(flags.project) ?? config.projectId;
      requireProject(projectId, 'lists');
      const lists = await client.listTaskLists(projectId);
      return output(asJson, lists, () =>
        lists.length
          ? lists.map((l) => `${l.id}\t${l.title}${l.archived ? ' (archived)' : ''}`).join('\n')
          : '(no task lists)',
      );
    }

    case 'tasks': {
      const projectId = str(flags.project) ?? config.projectId;
      const extraQuery = buildStatusQuery(str(flags.status));
      const data = await client.listTasks({
        projectId,
        limit: num(flags.limit),
        offset: num(flags.offset),
        extraQuery,
      });
      const tasks = data?.tasks ?? data;
      return output(asJson, tasks, () => formatTasks(tasks));
    }

    case 'task': {
      const taskId = requireId(positionals[0], 'task <taskId>');
      const data = await client.getTask(taskId);
      const task = (data?.tasks && data.tasks[0]) ?? data;
      return output(asJson, task, () => formatTaskDetail(task));
    }

    case 'create': {
      const title = str(flags.title);
      if (!title) fail(new Error('create: --title is required'));
      const projectId = str(flags.project) ?? config.projectId;
      requireProject(projectId, 'create');
      const data = await client.createTask({
        title,
        projectId,
        description: str(flags.desc) ?? str(flags.description),
        listId: str(flags.list) ?? config.listId,
        priority: num(flags.priority),
        assignedToId: str(flags.assignee),
        dueDate: str(flags.due),
        startDate: str(flags.start),
        msId: str(flags.milestone),
      });
      const task = (data?.tasks && data.tasks[0]) ?? data;
      return output(asJson, task, () => `Created task ${taskRef(task)}`);
    }

    case 'update': {
      const taskId = requireId(positionals[0], 'update <taskId>');
      const patch = buildPatch(flags);
      if (Object.keys(patch).length === 0) fail(new Error('update: no fields to change'));
      const data = await client.updateTask(taskId, patch);
      const task = (data?.tasks && data.tasks[0]) ?? data;
      return output(asJson, task, () => `Updated task ${taskId}`);
    }

    case 'status': {
      const taskId = requireId(positionals[0], 'status <taskId> <todo|doing|done>');
      const name = String(positionals[1] ?? '').toLowerCase();
      if (!(name in STATUS))
        fail(new Error(`status: expected one of todo|doing|done, got "${positionals[1]}"`));
      const data = await client.setTaskStatus(
        taskId,
        STATUS[/** @type {keyof typeof STATUS} */ (name)],
      );
      return output(asJson, data, () => `Task ${taskId} → ${name}`);
    }

    case 'comment': {
      const taskId = requireId(positionals[0], 'comment <taskId> --body "<text>"');
      const body = str(flags.body) ?? str(flags.message) ?? positionals.slice(1).join(' ');
      if (!body) fail(new Error('comment: --body is required'));
      const data = await client.addComment({ itemId: taskId, description: body });
      return output(asJson, data, () => `Commented on task ${taskId}`);
    }

    case 'delete': {
      const taskId = requireId(positionals[0], 'delete <taskId>');
      if (!flags.yes) {
        fail(new Error(`Refusing to delete task ${taskId} without --yes (destructive).`));
      }
      const data = await client.deleteTask(taskId);
      return output(asJson, data, () => `Deleted task ${taskId}`);
    }

    default:
      fail(new Error(`Unknown command: ${command}. Run "help".`));
  }
}

// ---- helpers ------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{ command: string|undefined, positionals: string[], flags: Record<string, string|boolean> }}
 */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  const positionals = [];
  let command;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else if (command === undefined) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

/**
 * @param {Record<string, string|boolean>} flags
 * @returns {Record<string, unknown>}
 */
function buildPatch(flags) {
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (str(flags.title) != null) patch.title = str(flags.title);
  const desc = str(flags.desc) ?? str(flags.description);
  if (desc != null) patch.description = desc;
  if (num(flags.priority) != null) patch.priority = String(num(flags.priority));
  if (str(flags.assignee) != null) patch.assigned_to_id = str(flags.assignee);
  if (str(flags.due) != null) patch.due_date = str(flags.due);
  if (num(flags.status) != null) patch.status = String(num(flags.status));
  return patch;
}

/**
 * Build a `status[]=` filter query from a friendly name or raw id.
 * @param {string|undefined} status
 * @returns {string|undefined}
 */
function buildStatusQuery(status) {
  if (!status) return undefined;
  const lower = status.toLowerCase();
  const id = lower in STATUS ? STATUS[/** @type {keyof typeof STATUS} */ (lower)] : Number(status);
  if (Number.isNaN(id)) return undefined;
  return `status[]=${id}`;
}

/**
 * @param {boolean} asJson
 * @param {unknown} data
 * @param {() => string} pretty
 */
function output(asJson, data, pretty) {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(pretty());
  }
}

/** @param {any[]} projects */
function formatProjects(projects) {
  if (!Array.isArray(projects) || projects.length === 0) return '(no projects)';
  return projects
    .map((p) => `${p.project_id ?? p.id}\t${p.project_name ?? p.name ?? ''}`)
    .join('\n');
}

/** @param {any[]} tasks */
function formatTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return '(no tasks)';
  return tasks.map((t) => `${t.id}\t[${statusLabel(t.status)}]\t${t.title ?? ''}`).join('\n');
}

/** @param {any} t */
function formatTaskDetail(t) {
  if (!t) return '(not found)';
  const lines = [
    `Task ${t.id}: ${t.title ?? ''}`,
    `Status: ${statusLabel(t.status)}   Priority: ${t.priority ?? '-'}   Due: ${t.due_date ?? '-'}`,
  ];
  if (t.description) lines.push('', String(t.description));
  return lines.join('\n');
}

/** @param {any} t */
function taskRef(t) {
  return t?.id ? `${t.id} (${t.title ?? ''})` : JSON.stringify(t);
}

/** @param {unknown} status */
function statusLabel(status) {
  const s = Number(status);
  if (s === 1) return 'done';
  if (s === 2) return 'doing';
  if (s === 0) return 'todo';
  return String(status ?? '?');
}

/** @param {string|null|undefined} projectId @param {string} cmd */
function requireProject(projectId, cmd) {
  if (!projectId) {
    fail(new Error(`${cmd}: no project id. Pass --project <id> or set FREEDCAMP_PROJECT_ID.`));
  }
}

/** @param {string|undefined} id @param {string} usage @returns {string} */
function requireId(id, usage) {
  if (!id) fail(new Error(`Missing task id. Usage: ${usage}`));
  return /** @type {string} */ (id);
}

/** @param {string|boolean|undefined} v @returns {string|undefined} */
function str(v) {
  return typeof v === 'string' ? v : undefined;
}

/** @param {string|boolean|undefined} v @returns {number|undefined} */
function num(v) {
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

/** @param {unknown} err @returns {never} */
function fail(err) {
  if (err instanceof ConfigError) {
    console.error(`Config error: ${err.message}`);
  } else if (err instanceof FreedcampApiError) {
    console.error(`Freedcamp API error: ${err.message}`);
    if (err.errors) console.error(JSON.stringify(err.errors, null, 2));
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
}

function printHelp() {
  // Print the top doc comment's usage section.
  console.log(
    [
      'freedcamp: manage Freedcamp projects, milestones and tasks.',
      '',
      'Usage: freedcamp <command> [options]',
      '',
      'Commands:',
      '  whoami                          Verify credentials.',
      '  projects                        List projects.',
      '  milestones [--project <id>]     List milestones (feature/epic containers).',
      '  milestone-create --title <t> --due <YYYY-MM-DD> [--desc d] [--priority n] [--project id]',
      '  milestone-status <id> <active|done>',
      '  lists   [--project <id>]        List task lists for a project.',
      '  tasks   [--project <id>] [--status todo|doing|done] [--limit n] [--offset n]',
      '  task    <taskId>                Show one task.',
      '  create  --title <t> [--desc d] [--project id] [--list id] [--priority n] [--assignee id] [--due YYYY-MM-DD] [--milestone <msId>]',
      '  update  <taskId> [--title t] [--desc d] [--priority n] [--assignee id] [--due YYYY-MM-DD] [--status 0|1|2]',
      '  status  <taskId> <todo|doing|done>',
      '  comment <taskId> --body "<text>"',
      '  delete  <taskId> --yes',
      '',
      'Global: --json  --yes  --env-file <path>',
    ].join('\n'),
  );
}
