#!/usr/bin/env node
// Copyright 2026 Firedance Multimedia LLC
// SPDX-License-Identifier: Apache-2.0
// @ts-check
/* eslint-disable no-console */

/**
 * Freedcamp MCP server (stdio transport).
 *
 * Exposes Freedcamp projects, milestones and tasks as MCP tools for AI coding
 * agents. It reuses the same `FreedcampClient` as the CLI, so auth, request
 * signing and error handling are identical.
 *
 * Credentials are read from the environment (see README.md):
 *   FREEDCAMP_API_KEY (required), FREEDCAMP_API_SECRET (secured keys),
 *   FREEDCAMP_PROJECT_ID / FREEDCAMP_LIST_ID (defaults), FREEDCAMP_BASE_URL.
 * For local use it also sources `.env.freedcamp` then `.env` from the
 * current directory (real env always wins), matching the CLI.
 *
 * MCP clients launch this over stdio; nothing but MCP protocol frames may
 * be written to stdout.
 */

import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, loadDotenvInto, ConfigError } from '../lib/config.mjs';
import { FreedcampClient, FreedcampApiError } from '../lib/client.mjs';

// Source local dotenv files for convenience; real env wins. Never log values.
loadDotenvInto(resolve('.env.freedcamp'));
loadDotenvInto(resolve('.env'));

let config;
try {
  config = loadConfig();
} catch (err) {
  // Fail loud on stderr (stdout is reserved for the protocol) and exit so
  // the MCP client surfaces a clear "server failed to start" state.
  console.error(
    err instanceof ConfigError
      ? `[freedcamp-mcp] ${err.message}`
      : `[freedcamp-mcp] Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

const client = new FreedcampClient(config);

const server = new McpServer({
  name: 'freedcamp',
  version: '0.1.0',
});

/**
 * Wrap a client call so any FreedcampApiError becomes an MCP tool error
 * result (isError) rather than crashing the server, and successful data is
 * returned as pretty JSON text content.
 *
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<{ content: Array<{ type: 'text', text: string }>, isError?: boolean }>}
 */
async function run(fn) {
  try {
    const data = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(data ?? null, null, 2) }] };
  } catch (err) {
    const message =
      err instanceof FreedcampApiError
        ? `Freedcamp API error: ${err.message}${err.errors ? `\n${JSON.stringify(err.errors, null, 2)}` : ''}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

// ---- Tools --------------------------------------------------------------

server.registerTool(
  'freedcamp_whoami',
  {
    title: 'Verify Freedcamp credentials',
    description: 'Verify the configured Freedcamp credentials by fetching the current session.',
    inputSchema: {},
  },
  async () => run(() => client.currentSession()),
);

server.registerTool(
  'freedcamp_list_projects',
  {
    title: 'List Freedcamp projects',
    description: 'List all Freedcamp projects the configured API key can access.',
    inputSchema: {},
  },
  async () => run(() => client.listProjects()),
);

server.registerTool(
  'freedcamp_list_milestones',
  {
    title: 'List milestones',
    description:
      'List milestones (feature/epic containers) in a project. Defaults to FREEDCAMP_PROJECT_ID.',
    inputSchema: {
      project_id: z.string().optional().describe('Project id. Defaults to FREEDCAMP_PROJECT_ID.'),
    },
  },
  async ({ project_id }) => {
    const pid = project_id ?? config.projectId;
    if (!pid) return errText('No project_id and no FREEDCAMP_PROJECT_ID default configured.');
    return run(() => client.listMilestones(pid));
  },
);

server.registerTool(
  'freedcamp_create_milestone',
  {
    title: 'Create a milestone (feature/epic)',
    description:
      'Create a milestone that documents a whole feature/epic; per-slice tasks link to it via milestone_id. Requires a due date.',
    inputSchema: {
      title: z.string().describe('Feature/epic title, e.g. "lighting: chase effect".'),
      due_date: z.string().describe('Due date, YYYY-MM-DD (required by Freedcamp).'),
      description: z.string().optional().describe('Full feature scope / summary.'),
      priority: z.number().int().optional().describe('Priority id (default 2).'),
      project_id: z.string().optional().describe('Project id. Defaults to FREEDCAMP_PROJECT_ID.'),
    },
  },
  async (args) => {
    const projectId = args.project_id ?? config.projectId;
    if (!projectId) return errText('No project_id and no FREEDCAMP_PROJECT_ID default configured.');
    return run(() =>
      client.createMilestone({
        title: args.title,
        projectId,
        dueDate: args.due_date,
        priority: args.priority,
        description: args.description,
      }),
    );
  },
);

server.registerTool(
  'freedcamp_set_milestone_status',
  {
    title: 'Set milestone status',
    description:
      'Mark a milestone active or done. Close a feature milestone only after human sign-off.',
    inputSchema: {
      milestone_id: z.string().describe('The Freedcamp milestone id.'),
      status: z.enum(['active', 'done']).describe('Target status.'),
    },
  },
  async ({ milestone_id, status }) =>
    run(() => client.setMilestoneStatus(milestone_id, status === 'done' ? 1 : 0)),
);

server.registerTool(
  'freedcamp_list_task_lists',
  {
    title: 'List task lists',
    description:
      'List the distinct task lists (groups) used in a project. Derived from the project tasks. Defaults to FREEDCAMP_PROJECT_ID if project_id is omitted.',
    inputSchema: {
      project_id: z.string().optional().describe('Project id. Defaults to FREEDCAMP_PROJECT_ID.'),
    },
  },
  async ({ project_id }) => {
    const pid = project_id ?? config.projectId;
    if (!pid) return errText('No project_id and no FREEDCAMP_PROJECT_ID default configured.');
    return run(() => client.listTaskLists(pid));
  },
);

server.registerTool(
  'freedcamp_list_tasks',
  {
    title: 'List tasks',
    description:
      'List tasks, optionally scoped to a project and filtered by status. Defaults to FREEDCAMP_PROJECT_ID.',
    inputSchema: {
      project_id: z.string().optional().describe('Project id. Defaults to FREEDCAMP_PROJECT_ID.'),
      status: z
        .enum(['todo', 'doing', 'done'])
        .optional()
        .describe('Filter by lifecycle status (todo=0, doing=2, done=1).'),
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default/max 200).'),
      offset: z.number().int().min(0).optional().describe('Pagination offset.'),
    },
  },
  async ({ project_id, status, limit, offset }) => {
    const extraQuery = statusQuery(status);
    return run(() =>
      client.listTasks({
        projectId: project_id ?? config.projectId,
        limit,
        offset,
        extraQuery,
      }),
    );
  },
);

server.registerTool(
  'freedcamp_get_task',
  {
    title: 'Get a task',
    description: 'Fetch a single task by id, including description, comments, and files.',
    inputSchema: { task_id: z.string().describe('The Freedcamp task id.') },
  },
  async ({ task_id }) => run(() => client.getTask(task_id)),
);

server.registerTool(
  'freedcamp_create_task',
  {
    title: 'Create a task',
    description:
      'Create a task. Defaults project_id/list_id to FREEDCAMP_PROJECT_ID/FREEDCAMP_LIST_ID when omitted. Titles should follow "<scope>: <summary>".',
    inputSchema: {
      title: z.string().describe('Task title, e.g. "music: resync poller slice".'),
      description: z.string().optional().describe('Task description / body.'),
      project_id: z.string().optional().describe('Project id. Defaults to FREEDCAMP_PROJECT_ID.'),
      list_id: z.string().optional().describe('Task list id. Defaults to FREEDCAMP_LIST_ID.'),
      priority: z.number().int().optional().describe('Priority id (see Freedcamp priorities).'),
      assigned_to_id: z.string().optional().describe('Assignee user id (-1 everyone, 0 no-one).'),
      due_date: z.string().optional().describe('Due date, YYYY-MM-DD.'),
      milestone_id: z
        .string()
        .optional()
        .describe('Link this slice task to a feature milestone (epic).'),
    },
  },
  async (args) => {
    const projectId = args.project_id ?? config.projectId;
    if (!projectId) return errText('No project_id and no FREEDCAMP_PROJECT_ID default configured.');
    return run(() =>
      client.createTask({
        title: args.title,
        projectId,
        description: args.description,
        listId: args.list_id ?? config.listId,
        priority: args.priority,
        assignedToId: args.assigned_to_id,
        dueDate: args.due_date,
        msId: args.milestone_id,
      }),
    );
  },
);

server.registerTool(
  'freedcamp_update_task',
  {
    title: 'Update a task',
    description: 'Edit a task. Only the provided fields are changed.',
    inputSchema: {
      task_id: z.string().describe('The Freedcamp task id.'),
      title: z.string().optional(),
      description: z.string().optional(),
      priority: z.number().int().optional(),
      assigned_to_id: z.string().optional(),
      due_date: z.string().optional().describe('YYYY-MM-DD.'),
      status: z
        .enum(['todo', 'doing', 'done'])
        .optional()
        .describe('Lifecycle status (todo=0, doing=2, done=1).'),
    },
  },
  async ({ task_id, ...rest }) => {
    /** @type {Record<string, unknown>} */
    const patch = {};
    if (rest.title != null) patch.title = rest.title;
    if (rest.description != null) patch.description = rest.description;
    if (rest.priority != null) patch.priority = String(rest.priority);
    if (rest.assigned_to_id != null) patch.assigned_to_id = rest.assigned_to_id;
    if (rest.due_date != null) patch.due_date = rest.due_date;
    if (rest.status != null) patch.status = String(STATUS[rest.status]);
    if (Object.keys(patch).length === 0) return errText('No fields to update.');
    return run(() => client.updateTask(task_id, patch));
  },
);

server.registerTool(
  'freedcamp_set_task_status',
  {
    title: 'Set task status',
    description: 'Move a task to todo, doing, or done.',
    inputSchema: {
      task_id: z.string().describe('The Freedcamp task id.'),
      status: z.enum(['todo', 'doing', 'done']).describe('Target status.'),
    },
  },
  async ({ task_id, status }) => run(() => client.setTaskStatus(task_id, STATUS[status])),
);

server.registerTool(
  'freedcamp_add_comment',
  {
    title: 'Comment on a task',
    description: 'Add a comment to a task (e.g. a pipeline handoff note).',
    inputSchema: {
      task_id: z.string().describe('The Freedcamp task id.'),
      body: z.string().describe('Comment text.'),
    },
  },
  async ({ task_id, body }) => run(() => client.addComment({ itemId: task_id, description: body })),
);

server.registerTool(
  'freedcamp_delete_task',
  {
    title: 'Delete a task (destructive)',
    description:
      'Delete a task. Destructive and irreversible — requires confirm=true to guard against accidental deletes.',
    inputSchema: {
      task_id: z.string().describe('The Freedcamp task id.'),
      confirm: z.boolean().describe('Must be true to actually delete.'),
    },
  },
  async ({ task_id, confirm }) => {
    if (!confirm) return errText(`Refusing to delete task ${task_id} without confirm=true.`);
    return run(() => client.deleteTask(task_id));
  },
);

// ---- helpers ------------------------------------------------------------

/** @type {Record<'todo'|'doing'|'done', 0|1|2>} */
const STATUS = { todo: 0, doing: 2, done: 1 };

/** @param {('todo'|'doing'|'done')|undefined} status */
function statusQuery(status) {
  if (!status) return undefined;
  return `status[]=${STATUS[status]}`;
}

/** @param {string} text @returns {{ content: Array<{type:'text',text:string}>, isError: true }} */
function errText(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

// ---- start --------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[freedcamp-mcp] server started on stdio');
