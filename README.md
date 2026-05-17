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
| `publer_schedule_post`     | Schedule a post: specific time, auto-schedule, recycling, or recurring.|
| `publer_publish_post`      | Publish a post immediately (returns a `job_id`).                        |
| `publer_create_draft`      | Save a draft post (returns a `job_id`).                                 |
| `publer_create_posts_raw`  | Escape hatch: send a raw `bulk` payload for full API coverage.         |
| `publer_update_post`       | Update an existing post by ID (`PUT /posts/{id}`).                      |
| `publer_delete_posts`      | Permanently delete posts by ID (irreversible).                         |
| `publer_extract_link_metadata` | Fetch link preview metadata (title, description, images).          |
| `publer_list_signatures`   | List account signatures (for the `signature` arg).                     |
| `publer_get_media_options` | Facebook albums, Pinterest boards, saved watermarks.                   |
| `publer_search_locations`  | Search FB/IG/Threads locations (for the `location` arg).               |
| `publer_upload_media`      | Upload a local file directly (sync). Returns a media `id`.             |
| `publer_upload_media_from_url` | Import media by URL (async, returns a `job_id`).                   |
| `publer_check_job_status`  | Poll an async job (posts or URL media uploads) until it completes.     |
| `publer_get_post_insights` | Performance analytics for a social account's posts.                    |

### Posts: content & publishing

The ergonomic post tools (`schedule_post`, `publish_post`, `create_draft`)
build the `bulk` payload for you and cover every documented content type and
platform format through a small set of arguments:

- `content_type`: `status`, `photo`, `video`, `link`, `gif`, `poll`,
  `carousel`, `pdf`, … Inferred when omitted (link if `link` set, photo if
  `media` set, else status).
- `media`: array of media objects (passed through verbatim) — supports
  `alt_text`, `path`, `thumbnail`, `name`, `caption`, and for video
  `thumbnails` / `default_thumbnail` / `title`.
- `link`: nested link-preview object (`url`, `title`, `description`,
  `images`, `default_image`, `call_to_action`, …).
- `extra`: merged into every network block — covers content-type-specific
  fields, e.g. poll `{ options, duration, question }`, reel/short/story
  `{ details: { type } }`, Google offer `{ details: { ... } }`, Facebook
  carousel `{ sublinks }`, LinkedIn PDF `{ details:{type:"document"}, title }`.
- Per-account: `scheduled_at`, `labels`, `signature`, `watermark`,
  `location`, `share`, `comments`, `delete`, and `account_extra`
  (e.g. Pinterest `{ album_id }`).
- The block is keyed automatically by each account's provider. Pass the
  advanced `networks` map for fully custom per-network content (e.g. a
  multi-network poll where LinkedIn needs a separate `question`).
- `schedule_post` also exposes `auto` + `range` + `share_next`
  (auto-scheduling), `recycling`, and `recurring` (with `state: recurring`).

`publer_create_posts_raw` remains the escape hatch: send the `bulk` object
verbatim for multi-post batches or anything not expressible above.

### Attaching media to posts

Media must be uploaded to Publer first, then referenced by id:

1. `publer_upload_media` (local file, returns the media object with `id`
   immediately), or `publer_upload_media_from_url` (returns a `job_id`; poll
   `publer_check_job_status` to get the resulting media).
2. Pass the id(s) to a post tool's `media` argument, e.g.
   `media: [{ "id": "<media id>", "type": "image", "alt_text": "..." }]`.

### Rate limits

The Publer API allows 100 requests per rolling 2-minute window. On `429`
the server surfaces the `X-RateLimit-Reset` time in the error so you know
when to retry.

### Async post flow

`publer_schedule_post`, `publer_publish_post` and `publer_create_draft` are
asynchronous. They return a `job_id`; poll `publer_check_job_status` with that
`job_id` until the status is `complete` to see per-account successes and failures.

## Transport

stdio only. `stdout` is reserved for the MCP protocol; diagnostics go to `stderr`.
