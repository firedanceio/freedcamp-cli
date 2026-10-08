# freedcamp-cli

Manage [Freedcamp](https://freedcamp.com) projects, milestones and tasks from the terminal, from
scripts, or from an AI coding agent over MCP. Works on Freedcamp's free plan.

- `freedcamp`: a command-line tool, human-readable by default, `--json` for scripts
- `freedcamp-mcp`: an MCP server exposing the same operations as tools
- Secured API keys (HMAC-signed requests) and unsecured keys
- Node 20+; the CLI uses only built-in modules

## Install

```sh
npm install -g github:firedanceio/freedcamp-cli
```

## Set up

1. In Freedcamp, go to **My Account → Integrations → API** and create an API key. A **secured**
   key (with an API secret) is the safer choice.
2. Put your credentials in the environment, or in a `.env.freedcamp` file in the folder you run
   from (see [`.env.example`](.env.example)). Keep that file out of git.
   ```ini
   FREEDCAMP_API_KEY=your_key
   FREEDCAMP_API_SECRET=your_secret      # leave empty for an unsecured key
   FREEDCAMP_PROJECT_ID=123456           # optional default project
   FREEDCAMP_LIST_ID=                    # optional default task list
   ```
3. Check it works:
   ```sh
   freedcamp whoami
   ```

`freedcamp projects` shows project ids and `freedcamp lists --project <id>` shows task list ids.

## Commands

```text
whoami                          Verify credentials
projects                        List projects
milestones [--project <id>]     List milestones
milestone-create --title <t> --due <YYYY-MM-DD> [--desc d] [--priority n] [--project id]
milestone-status <id> <active|done>
lists   [--project <id>]        List task lists
tasks   [--project <id>] [--status todo|doing|done] [--limit n] [--offset n]
task    <taskId>                Show one task
create  --title <t> [--desc d] [--project id] [--list id] [--priority n] [--assignee id]
        [--due YYYY-MM-DD] [--milestone <id>]
update  <taskId> [--title t] [--desc d] [--priority n] [--assignee id] [--due YYYY-MM-DD]
        [--status 0|1|2]
status  <taskId> <todo|doing|done>
comment <taskId> --body "<text>"
delete  <taskId> --yes
```

Global options: `--json` (raw JSON output), `--yes` (skip confirmations), `--env-file <path>`.

## MCP server

Add it to any MCP client that launches servers over stdio. For example, in Claude Code:

```sh
claude mcp add freedcamp -e FREEDCAMP_API_KEY=... -e FREEDCAMP_API_SECRET=... -- freedcamp-mcp
```

Or in a JSON config:

```json
{
  "mcpServers": {
    "freedcamp": {
      "command": "freedcamp-mcp",
      "env": { "FREEDCAMP_API_KEY": "...", "FREEDCAMP_API_SECRET": "...", "FREEDCAMP_PROJECT_ID": "..." }
    }
  }
}
```

Tools: `freedcamp_whoami`, `freedcamp_list_projects`, `freedcamp_list_milestones`,
`freedcamp_create_milestone`, `freedcamp_set_milestone_status`, `freedcamp_list_task_lists`,
`freedcamp_list_tasks`, `freedcamp_get_task`, `freedcamp_create_task`, `freedcamp_update_task`,
`freedcamp_set_task_status`, `freedcamp_add_comment`, `freedcamp_delete_task`.

## From JavaScript

```js
import { FreedcampClient } from 'freedcamp-cli';
import { loadConfig } from 'freedcamp-cli/config';

const fc = new FreedcampClient(loadConfig());
const { projects } = await fc.listProjects();
```

## Notes

- Requests are signed with `HMAC-SHA1(api_key + timestamp, api_secret)` for secured keys; the key
  is also sent as an `X-API-KEY` header so it doesn't end up in request bodies or logs.
- Status ids: `0` to do, `2` in progress, `1` done.
- Freedcamp requires a due date and priority on milestones.

## Licence

Apache-2.0. Made by [Firedance](https://firedance.io), where it keeps our task tracker in step
with the work.
