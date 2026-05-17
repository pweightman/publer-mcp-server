# Publer MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that
exposes the [Publer](https://publer.com) social media management API as tools
for MCP clients such as Claude Desktop, Claude Code, and the Claude Agent SDK.

It covers accounts/workspaces, the full Posts Create surface (every documented
content type and platform format), post update/delete, media upload, link
metadata extraction, signatures, watermarks/albums, location search, async job
polling, and analytics — **17 tools** in total.

---

## Table of contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Connecting an MCP client](#connecting-an-mcp-client)
- [Tool reference](#tool-reference)
  - [Accounts & workspaces](#accounts--workspaces)
  - [Creating posts](#creating-posts)
  - [Managing posts](#managing-posts)
  - [Media](#media)
  - [Discovery & metadata](#discovery--metadata)
  - [Jobs & analytics](#jobs--analytics)
- [Content & platform cookbook](#content--platform-cookbook)
- [Common workflows](#common-workflows)
- [Rate limits](#rate-limits)
- [Error handling](#error-handling)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Project structure](#project-structure)
- [Status & caveats](#status--caveats)

---

## Requirements

- **Node.js >= 18** (developed and tested on Node 22; uses the built-in
  `fetch`, `FormData`, and `openAsBlob`).
- A **Publer API key**. The Public API is available to Enterprise plan users
  and Business plan users in good standing. Generate a key in Publer under
  **Settings → Access & Login → API Keys**, and grant the scopes your
  integration needs (e.g. `workspaces`, `accounts`, `posts`, `media`).

---

## Installation

```bash
git clone -b claude/build-publer-mcp-server-PLf3R \
  https://github.com/pweightman/publer-mcp-server.git
cd publer-mcp-server
npm install
npm run build
```

`npm run build` compiles `src/` → `dist/` and makes `dist/index.js`
executable. The runnable entry point is `dist/index.js`.

Verify the build:

```bash
node -e "require('fs').accessSync('dist/index.js')" && echo "build OK"
```

---

## Configuration

The server is configured entirely through environment variables:

| Variable              | Required | Description                                                                       |
| --------------------- | -------- | --------------------------------------------------------------------------------- |
| `PUBLER_API_KEY`      | yes      | Your Publer API key. Sent as `Authorization: Bearer-API <key>`.                   |
| `PUBLER_WORKSPACE_ID` | no       | Default workspace ID. Most tools accept a `workspace_id` argument that overrides. |
| `PUBLER_API_BASE_URL` | no       | Override the API base URL (default `https://app.publer.com/api/v1`).              |

A starter `.env.example` is included. The server does **not** auto-load `.env`;
set variables via your MCP client's `env` block (below) or your shell.

### Discovering your workspace ID

Workspace-scoped endpoints require the `Publer-Workspace-Id` header. List your
workspaces with **only** the API key — exactly what `publer_list_workspaces`
does:

```bash
curl -X GET "https://app.publer.com/api/v1/workspaces" \
  -H "Authorization: Bearer-API YOUR_API_KEY"
```

Set `PUBLER_WORKSPACE_ID` to the desired workspace `id`, or pass `workspace_id`
on individual tool calls.

---

## Connecting an MCP client

### Claude Desktop

Edit `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

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

Use an **absolute** path to `dist/index.js`. If `node` isn't on the GUI app's
`PATH`, use the absolute path to the Node binary in `command` (find it with
`which node`). Fully quit and reopen the client after editing — the server is a
long-lived child process and only picks up changes when respawned.

### Claude Code

```bash
claude mcp add publer \
  --env PUBLER_API_KEY=your_api_key_here \
  --env PUBLER_WORKSPACE_ID=optional_default_workspace_id \
  -- node /absolute/path/to/publer-mcp-server/dist/index.js
```

### Transport

stdio only. `stdout` is reserved for the MCP protocol; diagnostics are written
to `stderr`.

---

## Tool reference

All tools accept an optional `workspace_id` (unless noted) that overrides
`PUBLER_WORKSPACE_ID`. Results are returned as pretty-printed JSON; failures
are returned with `isError: true` and a descriptive message (including the
Publer error body when present).

### Accounts & workspaces

| Tool                      | Arguments       | Notes                                                |
| ------------------------- | --------------- | ---------------------------------------------------- |
| `publer_get_current_user` | `workspace_id?` | Profile and settings of the authenticated user.      |
| `publer_list_workspaces`  | _(none)_        | Lists accessible workspaces. Call this first.        |
| `publer_list_accounts`    | `workspace_id?` | Connected social accounts (id, name, provider, …).   |

### Creating posts

The three ergonomic post tools share a common content/account argument set and
build the Publer `bulk` payload for you. They are **asynchronous**: each
returns `{ data: { job_id } }` — poll `publer_check_job_status` until done.

**Shared arguments**

| Argument        | Type      | Description                                                                                  |
| --------------- | --------- | -------------------------------------------------------------------------------------------- |
| `text`          | string    | Post body / caption (required).                                                              |
| `account_ids`   | string[]  | Target social account IDs (required).                                                        |
| `content_type`  | string    | `status`, `photo`, `video`, `link`, `gif`, `poll`, `carousel`, `pdf`, … Inferred if omitted. |
| `media`         | object[]  | Uploaded media objects, passed through verbatim. `id` required.                              |
| `link`          | object    | Link-preview object (`url` required, plus `title`, `description`, `images`, …).               |
| `extra`         | object    | Merged into every network block (content-type-specific fields).                              |
| `networks`      | object    | Advanced: full per-network override map (bypasses auto-build).                               |
| `labels`        | string[]  | Applied to every account.                                                                    |
| `signature`     | string    | Signature ID appended to every account.                                                      |
| `watermark`     | object    | Watermark object applied to every account's media.                                           |
| `location`      | object    | Location object tagged on every account.                                                     |
| `share`         | object    | Auto-share callback applied to every account.                                                |
| `comments`      | object[]  | Follow-up comments applied to every account.                                                 |
| `delete`        | object    | Auto-delete/hide callback applied to every account.                                          |
| `account_extra` | object    | Extra fields merged into every account object (e.g. `{ album_id }`).                          |
| `workspace_id`  | string    | Workspace override.                                                                          |

| Tool                  | Extra arguments                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publer_schedule_post`| `scheduled_at?`, `state` (`scheduled`\|`recurring`, default `scheduled`), `auto?`, `range?` (`{start_date, end_date?}`), `share_next?`, `recycling?`, `recurring?` |
| `publer_publish_post` | _(shared only)_ — publishes immediately via `/posts/schedule/publish`.                                                                                    |
| `publer_create_draft` | `visibility` (`public`\|`private`, default `public`).                                                                                                     |

`publer_create_posts_raw` — escape hatch. Send the `bulk` object verbatim:

| Argument       | Type    | Description                                                  |
| -------------- | ------- | ------------------------------------------------------------ |
| `bulk`         | object  | `{ state, posts: [...] }` exactly as the API documents.      |
| `publish`      | boolean | `true` → `/posts/schedule/publish`; `false` → `/posts/schedule` (default). |
| `workspace_id` | string  | Workspace override.                                          |

### Managing posts

| Tool                  | Arguments                                  | Notes                                                                 |
| --------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| `publer_update_post`  | `post_id`, `post` (`{text, …}`), `workspace_id?` | `PUT /posts/{id}`. Published posts allow only network-specific fields. |
| `publer_delete_posts` | `post_ids` (string[]), `workspace_id?`      | **Irreversible.** Subject to Publer's role/state rules.               |

### Media

| Tool                           | Arguments                                                                  | Notes                                                                  |
| ------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `publer_upload_media`          | `file_path`, `direct_upload?`, `in_library?`, `workspace_id?`              | Direct multipart upload, **synchronous**. Returns media incl. `id`. Max 200 MB. |
| `publer_upload_media_from_url` | `media` (`[{url, name, caption?, source?}]`), `type?`, `direct_upload?`, `in_library?`, `workspace_id?` | Async; returns a `job_id`.                                             |

### Discovery & metadata

| Tool                            | Arguments                                              | Notes                                                            |
| ------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| `publer_extract_link_metadata`  | `url`, `workspace_id?`                                  | Title/description/images for a URL — prefill the `link` argument. |
| `publer_list_signatures`        | `workspace_id?`, `account_ids?`                         | Signatures per account (for the `signature` argument).           |
| `publer_get_media_options`      | `workspace_id?`, `account_ids?`                         | Facebook albums, Pinterest boards, saved watermarks.             |
| `publer_search_locations`       | `network` (`facebook`\|`instagram`\|`threads`), `query`, `workspace_id?` | Location search (for the `location` argument).                   |

### Jobs & analytics

| Tool                       | Arguments                                                                                                   | Notes                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `publer_check_job_status`  | `job_id`, `workspace_id?`                                                                                    | Poll posts / URL-media-upload jobs until `status: completed`.  |
| `publer_get_post_insights` | `account_id`, `from?`, `to?`, `post_type?`, `query?`, `labels?`, `sort?`, `page?`, `competitors?`, `competitor_id?`, `workspace_id?` | Per-post analytics with filtering, sorting, pagination.        |

---

## Content & platform cookbook

The ergonomic tools auto-key the `networks` block by each account's provider
(resolved via the accounts endpoint). You supply the **content shape**; the
server assembles the `bulk` payload. Examples below show the relevant tool
arguments.

**Text post**

```json
{ "text": "Exciting news! #launch", "account_ids": ["ACC"] }
```

**Photo post**

```json
{
  "text": "Our new product",
  "account_ids": ["ACC"],
  "content_type": "photo",
  "media": [{ "id": "MEDIA_ID", "alt_text": "Product on white" }]
}
```

**Video / Reel / Short / Story**

```json
{
  "text": "Summer reel!",
  "account_ids": ["IG"],
  "content_type": "video",
  "media": [{
    "id": "VIDEO_ID", "path": "https://.../v.mp4", "type": "video",
    "thumbnails": [{ "id": "T", "small": "s", "real": "r" }],
    "default_thumbnail": 1
  }],
  "extra": { "details": { "type": "reel", "feed": false } }
}
```

**Link post** (use `publer_extract_link_metadata` to prefill)

```json
{
  "text": "Check this out",
  "account_ids": ["FB"],
  "link": {
    "url": "https://publer.com",
    "title": "Publer",
    "description": "Social media management",
    "images": ["https://.../og.png"],
    "default_image": 0,
    "call_to_action": "LEARN_MORE"
  }
}
```

**Poll** (single network — for multi-network polls where LinkedIn needs a
separate `question`, use the `networks` override or `publer_create_posts_raw`)

```json
{
  "text": "Favorite season?",
  "account_ids": ["TW"],
  "content_type": "poll",
  "extra": { "options": ["Spring", "Summer", "Autumn", "Winter"], "duration": 7 }
}
```

**GIF post**

```json
{
  "text": "Reaction!",
  "account_ids": ["ACC"],
  "content_type": "gif",
  "media": [{
    "id": "external", "type": "gif",
    "url": "https://media.giphy.com/.../giphy.gif",
    "path": "https://media.giphy.com/.../giphy.gif",
    "thumbnail": "https://media.giphy.com/.../200w.webp",
    "name": "Fun GIF"
  }]
}
```

**Facebook multi-link carousel**

```json
{
  "text": "Explore our features",
  "account_ids": ["FB_PAGE"],
  "content_type": "carousel",
  "extra": { "sublinks": [
    { "url": "https://publer.com", "title": "Dashboard", "images": ["..."], "call_to_action": "LEARN_MORE" },
    { "url": "https://publer.com/pricing", "title": "Pricing", "images": ["..."], "call_to_action": "SIGN_UP" }
  ]}
}
```

**LinkedIn PDF carousel**

```json
{
  "text": "Our deck",
  "account_ids": ["LI"],
  "content_type": "photo",
  "media": [{ "id": "M1", "type": "photo" }, { "id": "M2", "type": "photo" }],
  "extra": { "details": { "type": "document" }, "title": "Q3 Report" }
}
```

**Google Business offer**

```json
{
  "text": "30% off sitewide!",
  "account_ids": ["GBP"],
  "content_type": "photo",
  "media": [{ "id": "M1", "type": "photo" }],
  "extra": {
    "title": "LEARN_MORE",
    "url": "https://publer.com/sale",
    "details": { "type": "offer", "title": "Spring Sale",
      "start": "2025-05-28T12:50:00Z", "end": "2025-10-02T12:50:00Z",
      "coupon": "30OFF", "terms": "https://publer.com/terms" }
  }
}
```

**Pinterest pin with link & board**

```json
{
  "text": "New blog post!",
  "account_ids": ["PIN"],
  "content_type": "photo",
  "media": [{ "id": "external-0", "type": "photo", "path": "https://.../p.jpg" }],
  "extra": { "title": "Latest Article", "url": "https://publer.com/blog" },
  "account_extra": { "album_id": "BOARD_ID" }
}
```

**Per-account callbacks (auto-share, follow-up comments, auto-delete)**

```json
{
  "text": "Post with callbacks",
  "account_ids": ["FB"],
  "scheduled_at": "2025-10-31T10:23:00Z",
  "share": {
    "account_ids": ["OTHER"],
    "text": "Auto-shared!",
    "conditions": { "relation": "AND", "clauses": {
      "age": { "duration": 1, "unit": "Hour" },
      "engagements": { "comparison": "gt", "value": 10 } } }
  },
  "comments": [{ "text": "First 100 get 10% off!" }],
  "delete": { "conditions": { "clauses": {
    "age": { "duration": 7, "unit": "Day" } } }, "hide": false }
}
```

**Signature / watermark / location**

```json
{
  "text": "Branded post",
  "account_ids": ["FB"],
  "signature": "SIGNATURE_ID",
  "watermark": { "id": "WM_ID", "position": "bottom_right", "opacity": 80 },
  "location": { "id": "LOC_ID", "name": "Tirana" }
}
```

**Auto-scheduling**

```json
{
  "text": "Let Publer pick the time",
  "account_ids": ["ACC"],
  "auto": true,
  "range": { "start_date": "2025-05-23T07:45:00Z", "end_date": "2025-05-31T23:59:00Z" }
}
```

Next available slot: set `auto: true`, `share_next: true`, and a `range` with
only `start_date`.

**Recurring**

```json
{
  "text": "Weekly tip",
  "account_ids": ["ACC"],
  "state": "recurring",
  "recurring": { "start_date": "2025-05-05T13:29:00Z", "end_date": "2025-06-21T13:29:00Z",
    "repeat": "weekly", "days_of_week": [1, 4, 6], "repeat_rate": 1 }
}
```

When the ergonomic shape can't express something (multi-post batches, fully
divergent per-network content, per-account differences), drop down to
`publer_create_posts_raw` and send the `bulk` object verbatim.

---

## Common workflows

**Post with media**

1. `publer_upload_media` (local file → media object with `id`), or
   `publer_upload_media_from_url` (→ `job_id`, then `publer_check_job_status`
   for the resulting media).
2. Pass the id(s) into a post tool's `media` argument.

**Async post flow**

Post tools return `{ data: { job_id } }`. Poll `publer_check_job_status` with
that `job_id` until `status: completed` to see per-account successes/failures.

**Find IDs before deleting/updating**

Use `publer_get_post_insights` (or the Publer dashboard) to obtain post IDs,
then `publer_update_post` / `publer_delete_posts`.

---

## Rate limits

Publer enforces **100 requests per rolling 2-minute window** per user account.
On `429 Too Many Requests` the server includes the `X-RateLimit-Reset` time
(and remaining count) in the error message so the caller knows when to retry.
Daily per-network posting limits also apply (vary by plan) — see Publer's docs.

---

## Error handling

- Non-2xx responses raise a `PublerApiError`; the tool returns
  `isError: true` with the HTTP status and the Publer error body.
- Async post failures appear in the `publer_check_job_status` payload
  (`failures` with `account_id`, `provider`, `error`), not as a transport
  error — always check the job result.
- Missing/invalid `PUBLER_API_KEY` produces a clear startup error on `stderr`
  and the process exits with code 1.

---

## Troubleshooting

| Symptom                                            | Likely cause / fix                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Client shows "Server disconnected" on startup      | Check the client's `mcp-server-publer.log`. Usually missing `PUBLER_API_KEY`, `node` not on PATH, or `npm run build` not run. |
| `Cannot find module '@modelcontextprotocol/sdk'`   | Run `npm install && npm run build` in the repo; ensure `node_modules` sits next to `dist/`. |
| `403 Invalid API key or not active`                | Wrong/disabled key, or the account lacks API access (Enterprise/Business).          |
| Changes not taking effect                          | `git pull && npm run build`, then fully restart the MCP client (it respawns the process). |
| `"missing the social network params"`              | An empty/incorrect `networks` block. Let the tool auto-build it, or supply a valid `networks` override. |

Quick manual smoke test (replace the key):

```bash
PUBLER_API_KEY=YOUR_KEY node dist/index.js
# Healthy: waits silently on stdin. Any printed error is the root cause.
```

---

## Development

```bash
npm run build    # tsc → dist/, chmod +x dist/index.js
npm run dev      # tsc --watch
npm start        # node dist/index.js
```

Source is TypeScript (strict, ESM, NodeNext). The HTTP layer and the
`bulk`-payload assembly live in `src/publer-client.ts`; tool definitions live
in `src/server.ts`.

---

## Project structure

```
publer-mcp-server/
├── src/
│   ├── index.ts          # stdio entry point
│   ├── server.ts         # MCP server + tool definitions
│   ├── publer-client.ts  # Publer API HTTP client + payload builder
│   └── config.ts         # env configuration
├── dist/                 # build output (gitignored)
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## Status & caveats

- Every tool is verified to register and route correctly, and the generated
  `bulk` payloads have been checked against Publer's documentation for the
  major content types (text, photo, video/reel, link, poll, callbacks,
  auto-scheduling, signature/watermark/location, Pinterest).
- Payloads are validated for **shape correctness against the docs**, but a full
  end-to-end publish against a live Publer account with a real API key is the
  recommended final verification. Start with
  `publer_create_draft` (`visibility: private`) →
  `publer_check_job_status`.
- The `extra` / `account_extra` / `networks` passthroughs plus
  `publer_create_posts_raw` ensure any current or future Publer field is
  expressible even if not modeled as a first-class argument.

---

## License

MIT
