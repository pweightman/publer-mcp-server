# Publer MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the
[Publer](https://publer.com) social media management API as tools for MCP clients
(Claude Desktop, Claude Code, etc.).

## Requirements

- Node.js >= 18
- A Publer API key (Enterprise plan, or Business plan in good standing).
  Generate one in Publer under **Settings → Access & Login → API Keys**.

## Install & build

```bash
npm install
npm run build
```

## Configuration

The server is configured entirely through environment variables:

| Variable               | Required | Description                                                                 |
| ---------------------- | -------- | --------------------------------------------------------------------------- |
| `PUBLER_API_KEY`       | yes      | Your Publer API key. Sent as `Authorization: Bearer-API <key>`.             |
| `PUBLER_WORKSPACE_ID`  | no       | Default workspace ID. Most tools also accept a `workspace_id` override.     |
| `PUBLER_API_BASE_URL`  | no       | Override the API base URL (default `https://app.publer.com/api/v1`).        |

### Discovering your workspace ID

Workspace-scoped endpoints require the `Publer-Workspace-Id` header. To find your
workspace IDs, call the workspaces endpoint with **only** the API key — exactly
what the `publer_list_workspaces` tool does:

```bash
curl -X GET "https://app.publer.com/api/v1/workspaces" \
  -H "Authorization: Bearer-API YOUR_API_KEY"
```

Then set `PUBLER_WORKSPACE_ID` (or pass `workspace_id` per call).

## Claude Desktop / Claude Code configuration

```json
{
  "mcpServers": {
    "publer": {
      "command": "node",
      "args": ["/absolute/path/to/publer-mcp-server/dist/index.js"],
      "env": {
        "PUBLER_API_KEY": "your_api_key_here",
        "PUBLER_WORKSPACE_ID": "optional_default_workspace_id"
      }
    }
  }
}
```

## Tools

| Tool                       | Description                                                            |
| -------------------------- | ---------------------------------------------------------------------- |
| `publer_get_current_user`  | Profile and settings of the authenticated user.                        |
| `publer_list_workspaces`   | List accessible workspaces (call this first to get workspace IDs).     |
| `publer_list_accounts`     | List connected social accounts in a workspace.                         |
| `publer_schedule_post`     | Schedule a post (returns a `job_id`).                                   |
| `publer_publish_post`      | Publish a post immediately (returns a `job_id`).                        |
| `publer_create_draft`      | Save a draft post (returns a `job_id`).                                 |
| `publer_check_job_status`  | Poll an async post job until it completes.                             |
| `publer_get_post_insights` | Performance analytics for a social account's posts.                    |

### Async post flow

`publer_schedule_post`, `publer_publish_post` and `publer_create_draft` are
asynchronous. They return a `job_id`; poll `publer_check_job_status` with that
`job_id` until the status is `complete` to see per-account successes and failures.

## Transport

stdio only. `stdout` is reserved for the MCP protocol; diagnostics go to `stderr`.
