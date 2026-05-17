import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { PublerApiError, PublerClient } from "./publer-client.js";
import type { SimplePostInput, QueryValue } from "./publer-client.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function fail(error: unknown): ToolResult {
  let message: string;
  if (error instanceof PublerApiError) {
    const detail =
      error.body === undefined
        ? ""
        : `\n${JSON.stringify(error.body, null, 2)}`;
    message = `${error.message}${detail}`;
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }
  return { content: [{ type: "text", text: message }], isError: true };
}

const workspaceArg = z
  .string()
  .optional()
  .describe(
    "Workspace ID to scope this request to. Defaults to PUBLER_WORKSPACE_ID. " +
      "Use publer_list_workspaces to discover IDs.",
  );

const accountIdsArg = z
  .array(z.string().min(1))
  .min(1)
  .describe(
    "Publer social account IDs to post to. Discover them with publer_list_accounts.",
  );

const mediaArg = z
  .array(z.looseObject({ id: z.string().min(1) }))
  .optional()
  .describe(
    "Media items, referenced by uploaded media id (upload first with " +
      "publer_upload_media / publer_upload_media_from_url). Each item is a " +
      "media object passed through verbatim. Common fields: id (required), " +
      "type (image|video|document|photo|gif), alt_text, path, thumbnail, " +
      "name, caption, title; videos: thumbnails [{id,small,real}] and " +
      "default_thumbnail (index). type defaults to image for photo/carousel " +
      "posts and document for pdf.",
  );

const contentTypeArg = z
  .string()
  .optional()
  .describe(
    "Network block content type: status, photo, video, link, gif, poll, " +
      "carousel, pdf, etc. Inferred when omitted: link if `link` is set, " +
      "photo if media is attached, otherwise status.",
  );

const linkArg = z
  .looseObject({ url: z.string().url() })
  .optional()
  .describe(
    "Link-preview metadata for link posts. Fields: url (required), title, " +
      "description, images (string[]), default_image (index), " +
      "call_to_action (e.g. LEARN_MORE, SIGN_UP), provider_display, " +
      "phone_number. Use publer_extract_link_metadata to prefill these.",
  );

const extraArg = z
  .record(z.string(), z.any())
  .optional()
  .describe(
    "Extra fields merged into every auto-built network block, for " +
      "content-type-specific options. Examples: poll -> { options: " +
      "[...], duration: 7, question: '...' }; reel/short/story -> " +
      "{ details: { type: 'reel' } }; Google event/offer -> { title, url, " +
      "details: { type: 'offer', start, end, coupon, terms } }; Facebook " +
      "carousel -> { sublinks: [...] }; LinkedIn PDF -> { details: { type: " +
      "'document' }, title }; Pinterest pin -> { url, title }.",
  );

const labelsArg = z
  .array(z.string())
  .optional()
  .describe("Labels applied to every selected account.");

const signatureArg = z
  .string()
  .optional()
  .describe(
    "Signature id appended to every selected account (from " +
      "publer_list_signatures).",
  );

const watermarkArg = z
  .record(z.string(), z.any())
  .optional()
  .describe(
    "Watermark object applied to media for every selected account " +
      "(full object from media options: id, name, opacity, size, " +
      "position, image, default).",
  );

const locationArg = z
  .record(z.string(), z.any())
  .optional()
  .describe(
    "Location object to tag on every selected account (from " +
      "publer_search_locations): id, name, info, address, etc. " +
      "Facebook Pages / Instagram Business / Threads only.",
  );

const shareArg = z
  .record(z.string(), z.any())
  .optional()
  .describe(
    "Auto-share callback applied to every selected account: " +
      "{ account_ids: [...], text, conditions: { relation: 'AND'|'OR', " +
      "clauses: { age: { duration, unit }, engagements: { comparison, " +
      "value }, reach: { comparison, value } } }, delay: { duration, unit } }.",
  );

const commentsArg = z
  .array(z.record(z.string(), z.any()))
  .optional()
  .describe(
    "Follow-up comments applied to every selected account. Each: " +
      "{ text, language?, media?, conditions? } where conditions uses the " +
      "same relation/clauses (age/engagements/reach) model as share.",
  );

const deleteArg = z
  .record(z.string(), z.any())
  .optional()
  .describe(
    "Auto-delete/hide callback applied to every selected account: " +
      "{ conditions: { clauses: { age: { duration, unit }, engagements: " +
      "{ comparison, value } } }, hide: boolean }.",
  );

const accountExtraArg = z
  .record(z.string(), z.any())
  .optional()
  .describe(
    "Extra fields merged into every selected account object, e.g. " +
      "Pinterest { album_id }, or any other per-account field.",
  );

const networksArg = z
  .record(z.string(), z.any())
  .optional()
  .describe(
    "Advanced: full per-network override map keyed by provider " +
      "(facebook, instagram, twitter, linkedin, pinterest, youtube, tiktok, " +
      "google, telegram, mastodon, threads, bluesky, wordpress_basic, " +
      "wordpress_oauth) for network-specific content. Bypasses auto-resolution.",
  );

/** Shared network-block content args for the ergonomic post tools. */
const contentShape = {
  media: mediaArg,
  content_type: contentTypeArg,
  link: linkArg,
  extra: extraArg,
  networks: networksArg,
};

/** Shared per-account args for the ergonomic post tools. */
const accountShape = {
  labels: labelsArg,
  signature: signatureArg,
  watermark: watermarkArg,
  location: locationArg,
  share: shareArg,
  comments: commentsArg,
  delete: deleteArg,
  account_extra: accountExtraArg,
};

type SharedPostArgs = {
  text: string;
  account_ids: string[];
  media?: unknown[];
  content_type?: string;
  link?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  networks?: Record<string, unknown>;
  labels?: string[];
  signature?: string;
  watermark?: Record<string, unknown>;
  location?: Record<string, unknown>;
  share?: Record<string, unknown>;
  comments?: Record<string, unknown>[];
  delete?: Record<string, unknown>;
  account_extra?: Record<string, unknown>;
  scheduled_at?: string;
};

function mapPostInput(a: SharedPostArgs): SimplePostInput {
  return {
    text: a.text,
    accountIds: a.account_ids,
    media: a.media as SimplePostInput["media"],
    contentType: a.content_type,
    link: a.link as SimplePostInput["link"],
    extra: a.extra,
    networks: a.networks,
    labels: a.labels,
    signature: a.signature,
    watermark: a.watermark,
    location: a.location,
    share: a.share,
    comments: a.comments,
    delete: a.delete,
    accountExtra: a.account_extra,
    scheduledAt: a.scheduled_at,
  };
}

export function createServer(): McpServer {
  const config = loadConfig();
  const client = new PublerClient(config);

  const server = new McpServer({
    name: "publer-mcp-server",
    version: "0.1.0",
  });

  // --- Accounts & workspaces -------------------------------------------------

  server.registerTool(
    "publer_get_current_user",
    {
      title: "Get current Publer user",
      description:
        "Retrieve the profile and application settings of the authenticated Publer user.",
      inputSchema: { workspace_id: workspaceArg },
    },
    async ({ workspace_id }) => {
      try {
        return ok(await client.getCurrentUser(workspace_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_list_workspaces",
    {
      title: "List Publer workspaces",
      description:
        "List all workspaces the authenticated user can access, including id, name, role and picture.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await client.listWorkspaces());
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_list_accounts",
    {
      title: "List Publer social accounts",
      description:
        "List the connected social media accounts in a workspace (id, name, provider, type, picture, status).",
      inputSchema: { workspace_id: workspaceArg },
    },
    async ({ workspace_id }) => {
      try {
        return ok(await client.listAccounts(workspace_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  // --- Create & schedule posts ----------------------------------------------

  server.registerTool(
    "publer_schedule_post",
    {
      title: "Schedule a Publer post",
      description:
        "Schedule a post across one or more social accounts (any content " +
        "type / platform format via content_type + media + link + extra). " +
        "Returns a job_id; poll publer_check_job_status until complete.",
      inputSchema: {
        text: z.string().min(1).describe("The post body / caption text."),
        account_ids: accountIdsArg,
        scheduled_at: z
          .string()
          .optional()
          .describe(
            "ISO 8601 publish time, e.g. 2026-06-01T09:00:00Z, applied to " +
              "every account. Required for a plain scheduled post; omit when " +
              "using auto-scheduling or recurring.",
          ),
        ...contentShape,
        ...accountShape,
        state: z
          .enum(["scheduled", "recurring"])
          .default("scheduled")
          .describe(
            "scheduled (specific time, or auto-scheduled with auto+range, or " +
              "recycled with recycling) or recurring (repeating posts).",
          ),
        auto: z
          .boolean()
          .optional()
          .describe(
            "Enable AI auto-scheduling: Publer picks the optimal time " +
              "within range. Provide range with this.",
          ),
        range: z
          .object({
            start_date: z
              .string()
              .describe(
                "Earliest ISO 8601 timestamp for posting (inclusive).",
              ),
            end_date: z
              .string()
              .optional()
              .describe(
                "Latest ISO 8601 timestamp (inclusive). Omit when using " +
                  "share_next for the next available slot.",
              ),
          })
          .optional()
          .describe("Auto-schedule window. Required when auto is true."),
        share_next: z
          .boolean()
          .optional()
          .describe(
            "Auto-scheduling: schedule in the very next available slot " +
              "(use with auto and a range that has only start_date).",
          ),
        recycling: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "Recycling config, e.g. { gap, gap_freq, expire_count, expire_date }.",
          ),
        recurring: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "Recurring config, e.g. { start_date, end_date, repeat, " +
              "days_of_week, repeat_rate }. Used with state=recurring.",
          ),
        workspace_id: workspaceArg,
      },
    },
    async (args) => {
      try {
        const a = args as unknown as SharedPostArgs & {
          state: SimplePostInput extends never ? never : string;
          auto?: boolean;
          range?: Record<string, unknown>;
          share_next?: boolean;
          recycling?: Record<string, unknown>;
          recurring?: Record<string, unknown>;
          workspace_id?: string;
        };
        const result = await client.createPosts(
          a.state as Parameters<typeof client.createPosts>[0],
          {
            ...mapPostInput(a),
            auto: a.auto,
            range: a.range,
            shareNext: a.share_next,
            recycling: a.recycling,
            recurring: a.recurring,
          },
          { workspaceId: a.workspace_id },
        );
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_publish_post",
    {
      title: "Publish a Publer post immediately",
      description:
        "Publish a post immediately to one or more social accounts (any " +
        "content type / platform format). Returns a job_id; poll " +
        "publer_check_job_status until complete.",
      inputSchema: {
        text: z.string().min(1).describe("The post body / caption text."),
        account_ids: accountIdsArg,
        ...contentShape,
        ...accountShape,
        workspace_id: workspaceArg,
      },
    },
    async (args) => {
      try {
        const a = args as unknown as SharedPostArgs & {
          workspace_id?: string;
        };
        const result = await client.createPosts(
          "scheduled",
          mapPostInput(a),
          { publish: true, workspaceId: a.workspace_id },
        );
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_create_draft",
    {
      title: "Create a Publer draft post",
      description:
        "Save a draft post without publishing. Returns a job_id; poll " +
        "publer_check_job_status until complete.",
      inputSchema: {
        text: z.string().min(1).describe("The post body / caption text."),
        account_ids: accountIdsArg,
        ...contentShape,
        ...accountShape,
        visibility: z
          .enum(["public", "private"])
          .default("public")
          .describe(
            "public: visible to the workspace. private: only the creator.",
          ),
        workspace_id: workspaceArg,
      },
    },
    async (args) => {
      try {
        const a = args as unknown as SharedPostArgs & {
          visibility: "public" | "private";
          workspace_id?: string;
        };
        const result = await client.createPosts(
          a.visibility === "private" ? "draft_private" : "draft_public",
          mapPostInput(a),
          { workspaceId: a.workspace_id },
        );
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_create_posts_raw",
    {
      title: "Create Publer posts from a raw bulk payload",
      description:
        "Escape hatch for the full Posts Create API. Send the `bulk` object " +
        "verbatim ({ state, posts: [...] }). Use for multi-post batches, " +
        "per-account share/comments/delete, network-specific content, " +
        "recycling/recurring, or any field the ergonomic post tools omit. " +
        "Returns a job_id; poll publer_check_job_status.",
      inputSchema: {
        bulk: z
          .object({
            state: z
              .string()
              .describe(
                "scheduled, draft, draft_private, draft_public, or recurring.",
              ),
            posts: z
              .array(z.record(z.string(), z.any()))
              .min(1)
              .describe(
                "Array of post definitions (networks, accounts, and any " +
                  "post-level options) exactly as the Publer API expects.",
              ),
          })
          .describe("The bulk container sent verbatim to the API."),
        publish: z
          .boolean()
          .default(false)
          .describe(
            "true -> POST /posts/schedule/publish (immediate); " +
              "false -> POST /posts/schedule.",
          ),
        workspace_id: workspaceArg,
      },
    },
    async ({ bulk, publish, workspace_id }) => {
      try {
        return ok(
          await client.createPostsRaw(bulk, {
            publish,
            workspaceId: workspace_id,
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_delete_posts",
    {
      title: "Delete Publer posts",
      description:
        "Permanently delete one or more posts of any state from the " +
        "workspace. Irreversible. Subject to Publer's authorization rules: " +
        "you can delete posts you created or posts in workspaces you own / " +
        "have post-action access to; private drafts only by their creator; " +
        "queued posts (except reminders) cannot be deleted. Returns the IDs " +
        "that were actually deleted.",
      inputSchema: {
        post_ids: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "Post IDs to delete (MongoDB ObjectIDs and/or PostgreSQL IDs).",
          ),
        workspace_id: workspaceArg,
      },
    },
    async ({ post_ids, workspace_id }) => {
      try {
        return ok(await client.deletePosts(post_ids, workspace_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_update_post",
    {
      title: "Update a Publer post",
      description:
        "Update an existing post by ID. For scheduled posts most fields can " +
        "change; for already-published posts only network-specific fields " +
        "(or just labels on some networks) are updatable. For recurring " +
        "posts the change applies to all future child posts.",
      inputSchema: {
        post_id: z
          .string()
          .min(1)
          .describe("ID of the post to update."),
        post: z
          .looseObject({
            text: z.string().describe("The main post text (required)."),
          })
          .describe(
            "Post fields to update, sent verbatim as { post: {...} }. " +
              "Common: text (required), title; plus any network-specific or " +
              "scheduling fields the API accepts.",
          ),
        workspace_id: workspaceArg,
      },
    },
    async ({ post_id, post, workspace_id }) => {
      try {
        return ok(
          await client.updatePost(
            post_id,
            post as Record<string, unknown>,
            workspace_id,
          ),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_list_posts",
    {
      title: "List Publer posts",
      description:
        "List and filter posts across connected accounts (paginated). Use " +
        "this to find post IDs for publer_update_post / publer_delete_posts.",
      inputSchema: {
        state: z
          .string()
          .optional()
          .describe(
            "Filter by a single post state, e.g. all, scheduled, " +
              "scheduled_pending, published, published_posted, draft, " +
              "draft_private, failed, recurring.",
          ),
        states: z
          .array(z.string())
          .optional()
          .describe("Filter by multiple states (sent as state[])."),
        from: z
          .string()
          .optional()
          .describe("ISO date — posts on/after (requires to)."),
        to: z
          .string()
          .optional()
          .describe("ISO date — posts on/before (requires from)."),
        page: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Page number (default 0)."),
        account_ids: z
          .array(z.string().min(1))
          .optional()
          .describe("Filter by these account IDs."),
        query: z
          .string()
          .optional()
          .describe("Full-text search in post content."),
        post_type: z
          .string()
          .optional()
          .describe("Filter by post type (photo, video, link, …)."),
        member_id: z
          .string()
          .optional()
          .describe("Filter by the workspace member who created the post."),
        workspace_id: workspaceArg,
      },
    },
    async ({
      states,
      post_type,
      account_ids,
      workspace_id,
      ...rest
    }) => {
      try {
        // request() appends [] to array values, so pass base key names.
        const q: Record<string, QueryValue> = {
          ...rest,
          postType: post_type,
        };
        if (account_ids) q.account_ids = account_ids;
        if (states) q.state = states;
        return ok(await client.listPosts(q, workspace_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_list_media",
    {
      title: "List Publer media library",
      description:
        "List and filter media library items (paginated). Returns ids " +
        "usable in post tools' media argument.",
      inputSchema: {
        ids: z
          .array(z.string().min(1))
          .optional()
          .describe("Specific media IDs (other filters ignored when set)."),
        types: z
          .array(z.enum(["photo", "video", "gif"]))
          .optional()
          .describe("Media type filter — photo, video, gif."),
        used: z
          .array(z.boolean())
          .optional()
          .describe("Filter by usage status."),
        source: z
          .array(z.string())
          .optional()
          .describe(
            "Source — canva, vista, postnitro, contentdrips, openai, " +
              "favorites, upload.",
          ),
        page: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Page number (0-based, default 0)."),
        search: z
          .string()
          .optional()
          .describe("Full-text search on name or caption."),
        workspace_id: workspaceArg,
      },
    },
    async ({ ids, types, used, source, page, search, workspace_id }) => {
      try {
        // request() appends [] to array values, so pass base key names.
        const q: Record<string, QueryValue> = { page, search };
        if (ids) q.ids = ids;
        if (types) q.types = types;
        if (used) q.used = used.map(String);
        if (source) q.source = source;
        return ok(await client.listMedia(q, workspace_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  // --- Discovery & metadata --------------------------------------------------

  server.registerTool(
    "publer_extract_link_metadata",
    {
      title: "Extract link preview metadata",
      description:
        "Fetch rich preview metadata (title, description, images, favicon) " +
        "from a URL. Use the result to prefill the `link` argument of post " +
        "tools for accurate link-post previews.",
      inputSchema: {
        url: z.string().url().describe("The URL to extract metadata from."),
        workspace_id: workspaceArg,
      },
    },
    async ({ url, workspace_id }) => {
      try {
        return ok(await client.extractLinkMetadata(url, workspace_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_list_signatures",
    {
      title: "List account signatures",
      description:
        "List signatures available for accounts in a workspace. Pass a " +
        "signature id to a post tool's `signature` argument to append it.",
      inputSchema: {
        workspace_id: z
          .string()
          .min(1)
          .describe(
            "Workspace ID (path param). Defaults to PUBLER_WORKSPACE_ID " +
              "if omitted.",
          )
          .optional(),
        account_ids: z
          .array(z.string().min(1))
          .optional()
          .describe("Filter signatures to these account IDs."),
      },
    },
    async ({ workspace_id, account_ids }) => {
      try {
        const ws = workspace_id ?? config.workspaceId;
        if (!ws) {
          throw new Error(
            "workspace_id is required (or set PUBLER_WORKSPACE_ID).",
          );
        }
        return ok(await client.listSignatures(ws, account_ids));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_get_media_options",
    {
      title: "Get media options (albums, boards, watermarks)",
      description:
        "List Facebook albums, Pinterest boards, and saved watermarks per " +
        "account. Use album/board IDs in account_extra (e.g. album_id) and " +
        "a watermark object in the `watermark` argument of post tools.",
      inputSchema: {
        workspace_id: z
          .string()
          .min(1)
          .describe(
            "Workspace ID (path param). Defaults to PUBLER_WORKSPACE_ID " +
              "if omitted.",
          )
          .optional(),
        account_ids: z
          .array(z.string().min(1))
          .optional()
          .describe("Filter media options to these account IDs."),
      },
    },
    async ({ workspace_id, account_ids }) => {
      try {
        const ws = workspace_id ?? config.workspaceId;
        if (!ws) {
          throw new Error(
            "workspace_id is required (or set PUBLER_WORKSPACE_ID).",
          );
        }
        return ok(await client.getMediaOptions(ws, account_ids));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_search_locations",
    {
      title: "Search locations to tag",
      description:
        "Search Facebook / Instagram / Threads locations by query. Pass a " +
        "returned location object to the `location` argument of post tools " +
        "(Facebook Pages, Instagram Business, Threads only).",
      inputSchema: {
        network: z
          .enum(["facebook", "instagram", "threads"])
          .describe("Which network's location index to search."),
        query: z
          .string()
          .min(1)
          .describe("Search query, e.g. a city or venue name."),
        workspace_id: workspaceArg,
      },
    },
    async ({ network, query, workspace_id }) => {
      try {
        return ok(
          await client.searchLocations(network, query, workspace_id),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  // --- Media -----------------------------------------------------------------

  server.registerTool(
    "publer_upload_media",
    {
      title: "Upload a media file to Publer",
      description:
        "Upload a local media file (image, video, or document) directly. " +
        "Synchronous; returns the media object including the `id` to pass in " +
        "the `media` argument of post tools. Max 200MB; use " +
        "publer_upload_media_from_url for larger files.",
      inputSchema: {
        file_path: z
          .string()
          .min(1)
          .describe("Absolute path to the local file to upload."),
        direct_upload: z
          .boolean()
          .default(false)
          .describe(
            "Upload to Publer's S3 (slower, required if you need the final media URL).",
          ),
        in_library: z
          .boolean()
          .default(false)
          .describe("Save the file to the workspace media library."),
        workspace_id: workspaceArg,
      },
    },
    async ({ file_path, direct_upload, in_library, workspace_id }) => {
      try {
        return ok(
          await client.uploadMediaFile(file_path, {
            directUpload: direct_upload,
            inLibrary: in_library,
            workspaceId: workspace_id,
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_upload_media_from_url",
    {
      title: "Import media into Publer from URLs",
      description:
        "Import one or more media files by URL. Asynchronous: returns a " +
        "job_id; poll publer_check_job_status until complete to get the " +
        "resulting media.",
      inputSchema: {
        media: z
          .array(
            z.object({
              url: z.string().url().describe("URL of the media file."),
              name: z.string().min(1).describe("Custom name for the media."),
              caption: z.string().optional().describe("Optional caption."),
              source: z
                .string()
                .optional()
                .describe("Optional source attribution."),
            }),
          )
          .min(1)
          .describe("Media items to import by URL."),
        type: z
          .string()
          .default("single")
          .describe("Upload type: single or bulk."),
        direct_upload: z
          .boolean()
          .default(false)
          .describe(
            "Upload to Publer's S3 (slower, required if you need the final media URL).",
          ),
        in_library: z
          .boolean()
          .default(false)
          .describe("Save the files to the workspace media library."),
        workspace_id: workspaceArg,
      },
    },
    async ({ media, type, direct_upload, in_library, workspace_id }) => {
      try {
        return ok(
          await client.uploadMediaFromUrl(media, {
            type,
            directUpload: direct_upload,
            inLibrary: in_library,
            workspaceId: workspace_id,
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  // --- Job status ------------------------------------------------------------

  server.registerTool(
    "publer_check_job_status",
    {
      title: "Check a Publer job status",
      description:
        "Poll the status of an asynchronous job. Post-creation tools and " +
        "publer_upload_media_from_url return a job_id; call this until status " +
        "is complete to see successes and failures.",
      inputSchema: {
        job_id: z
          .string()
          .min(1)
          .describe("The job_id returned by a post-creation tool."),
        workspace_id: workspaceArg,
      },
    },
    async ({ job_id, workspace_id }) => {
      try {
        return ok(await client.getJobStatus(job_id, workspace_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  // --- Analytics -------------------------------------------------------------

  const fromArg = z
    .string()
    .describe("Start date (YYYY-MM-DD, inclusive).");
  const toArg = z.string().describe("End date (YYYY-MM-DD, inclusive).");
  const sortTypeArg = z
    .enum(["ASC", "DESC", "asc", "desc"])
    .optional()
    .describe("Sort direction (default DESC).");
  const optionalAccountIdArg = z
    .string()
    .optional()
    .describe(
      "Social account ID. Omit to aggregate across all accessible accounts.",
    );

  server.registerTool(
    "publer_get_post_insights",
    {
      title: "Get Publer post insights",
      description:
        "Per-post performance analytics for published posts, with filtering, " +
        "sorting and pagination (10 posts/page).",
      inputSchema: {
        account_id: optionalAccountIdArg,
        from: fromArg,
        to: toArg,
        post_type: z
          .string()
          .optional()
          .describe(
            "Filter by post type (photo, video, reel, carousel, link, " +
              "status, story, short, document, article, poll).",
          ),
        query: z
          .string()
          .optional()
          .describe("Search across post text, title, link description."),
        sort_by: z
          .string()
          .optional()
          .describe(
            "scheduled_at, reach, engagement, engagement_rate, likes, " +
              "comments, shares, saves, etc.",
          ),
        sort_type: sortTypeArg,
        page: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-based page index (10 posts per page)."),
        member_id: z
          .string()
          .optional()
          .describe("Filter by the workspace member who created the post."),
        competitors: z
          .string()
          .optional()
          .describe("'true' to enable competitor insights."),
        competitor_id: z
          .string()
          .optional()
          .describe("Competitor account ID (requires competitors=true)."),
        workspace_id: workspaceArg,
      },
    },
    async ({ account_id, workspace_id, post_type, ...rest }) => {
      try {
        return ok(
          await client.getPostInsights(
            { ...rest, postType: post_type },
            account_id,
            workspace_id,
          ),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_list_charts",
    {
      title: "List Publer analytics charts",
      description:
        "List available analytics charts grouped by growth, insights and " +
        "demographics. Use the returned chart ids with publer_get_chart_data.",
      inputSchema: {
        account_type: z
          .string()
          .optional()
          .describe(
            "Filter charts for an account type, e.g. ig_business, fb_page, " +
              "twitter, linkedin, youtube, tiktok, google, threads, bluesky.",
          ),
        workspace_id: workspaceArg,
      },
    },
    async ({ account_type, workspace_id }) => {
      try {
        return ok(await client.listCharts(account_type, workspace_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_get_chart_data",
    {
      title: "Get Publer chart data",
      description:
        "Fetch time-series data for one or more charts (current vs previous " +
        "period). Get chart ids from publer_list_charts.",
      inputSchema: {
        chart_ids: z
          .array(z.string().min(1))
          .min(1)
          .describe("Chart IDs from publer_list_charts."),
        account_id: optionalAccountIdArg,
        from: z.string().optional().describe("Start date (YYYY-MM-DD)."),
        to: z.string().optional().describe("End date (YYYY-MM-DD)."),
        workspace_id: workspaceArg,
      },
    },
    async ({ chart_ids, account_id, from, to, workspace_id }) => {
      try {
        return ok(
          await client.getChartData(
            { chart_ids, from, to },
            account_id,
            workspace_id,
          ),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_get_hashtag_insights",
    {
      title: "Get Publer hashtag insights",
      description:
        "Aggregated analytics per hashtag (with up to 3 recent posts each " +
        "and a performance score), paginated 10/page.",
      inputSchema: {
        account_id: optionalAccountIdArg,
        from: z.string().optional().describe("Start date (YYYY-MM-DD)."),
        to: z.string().optional().describe("End date (YYYY-MM-DD)."),
        sort_by: z
          .string()
          .optional()
          .describe("posts, reach, likes, comments, shares, video_views."),
        sort_type: sortTypeArg,
        page: z.number().int().min(0).optional().describe("0-based page."),
        query: z
          .string()
          .optional()
          .describe("Case-insensitive hashtag filter."),
        member_id: z.string().optional().describe("Filter by post author."),
        workspace_id: workspaceArg,
      },
    },
    async ({ account_id, workspace_id, ...query }) => {
      try {
        return ok(
          await client.getHashtagInsights(query, account_id, workspace_id),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_get_hashtag_performing_posts",
    {
      title: "Get Publer hashtag performing posts",
      description:
        "Up to 6 top-performing posts that used a specific hashtag, with " +
        "full per-post analytics.",
      inputSchema: {
        hashtag: z
          .string()
          .min(1)
          .describe("Hashtag to analyse (include the #)."),
        account_id: optionalAccountIdArg,
        from: z.string().optional().describe("Start date (YYYY-MM-DD)."),
        to: z.string().optional().describe("End date (YYYY-MM-DD)."),
        sort_by: z
          .string()
          .optional()
          .describe("scheduled_at, reach, engagement, engagement_rate, likes."),
        sort_type: sortTypeArg,
        member_id: z.string().optional().describe("Filter by post author."),
        query: z
          .string()
          .optional()
          .describe("Text search in post text / title / link info."),
        workspace_id: workspaceArg,
      },
    },
    async ({ account_id, workspace_id, ...query }) => {
      try {
        return ok(
          await client.getHashtagPerformingPosts(
            query,
            account_id,
            workspace_id,
          ),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_get_best_times",
    {
      title: "Get Publer best times to post",
      description:
        "Day/hour heatmap (Monday..Sunday, 24 relative scores each) of " +
        "optimal posting times for an account.",
      inputSchema: {
        account_id: optionalAccountIdArg,
        from: fromArg,
        to: toArg,
        competitors: z
          .string()
          .optional()
          .describe("'true' to include competitor data."),
        competitor_id: z
          .string()
          .optional()
          .describe("Specific competitor (requires competitors=true)."),
        workspace_id: workspaceArg,
      },
    },
    async ({ account_id, workspace_id, ...query }) => {
      try {
        return ok(
          await client.getBestTimes(query, account_id, workspace_id),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_get_members_analytics",
    {
      title: "Get Publer members analytics",
      description:
        "Posting activity and engagement per workspace member within a " +
        "required date range.",
      inputSchema: {
        from: fromArg,
        to: toArg,
        account_id: z
          .string()
          .optional()
          .describe("Restrict analytics to one social account."),
        workspace_id: workspaceArg,
      },
    },
    async ({ from, to, account_id, workspace_id }) => {
      try {
        return ok(
          await client.getMembersAnalytics(
            { from, to, account_id },
            workspace_id,
          ),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_list_competitors",
    {
      title: "List Publer competitors",
      description:
        "List competitor accounts for the workspace, optionally scoped to a " +
        "social account.",
      inputSchema: {
        account_id: z
          .string()
          .optional()
          .describe("Social account ID to scope competitors."),
        workspace_id: workspaceArg,
      },
    },
    async ({ account_id, workspace_id }) => {
      try {
        return ok(await client.listCompetitors(account_id, workspace_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publer_get_competitor_analytics",
    {
      title: "Get Publer competitor analytics",
      description:
        "Paginated competitor analytics (followers, growth, engagement, " +
        "reach, posting mix) with filtering and sorting.",
      inputSchema: {
        account_id: z
          .string()
          .optional()
          .describe("Scope analytics to one social account."),
        competitor_id: z
          .string()
          .optional()
          .describe("Analyse a specific competitor."),
        query: z
          .string()
          .optional()
          .describe("Case-insensitive search by competitor name."),
        from: z.string().optional().describe("Start date (YYYY-MM-DD)."),
        to: z.string().optional().describe("End date (YYYY-MM-DD)."),
        page: z.number().int().min(0).optional().describe("0-based page."),
        sort_by: z
          .string()
          .optional()
          .describe(
            "followers, reach, engagement, posts_count, videos_count, " +
              "photos_count, links_count, statuses_count.",
          ),
        sort_type: sortTypeArg,
        workspace_id: workspaceArg,
      },
    },
    async ({ account_id, workspace_id, ...query }) => {
      try {
        return ok(
          await client.getCompetitorAnalytics(
            query,
            account_id,
            workspace_id,
          ),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}
