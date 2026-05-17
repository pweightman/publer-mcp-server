import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { PublerApiError, PublerClient } from "./publer-client.js";

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
  .array(
    z.object({
      id: z
        .string()
        .min(1)
        .describe("Media id returned by publer_upload_media / a completed upload job."),
      type: z
        .string()
        .optional()
        .describe("image | video | document. Defaults to image."),
      alt_text: z
        .string()
        .optional()
        .describe("Accessibility alt text for the media."),
    }),
  )
  .optional()
  .describe(
    "Media to attach, referenced by uploaded media id. Upload first with " +
      "publer_upload_media or publer_upload_media_from_url.",
  );

const contentTypeArg = z
  .enum(["status", "photo", "video", "link", "carousel", "pdf"])
  .optional()
  .describe(
    "Content type. Inferred when omitted: link if url is set, photo if " +
      "media is attached, otherwise status. Set explicitly for video, " +
      "carousel, or pdf.",
  );

const urlArg = z
  .string()
  .url()
  .optional()
  .describe("Link URL. Required for content_type=link.");

const labelsArg = z
  .array(z.string())
  .optional()
  .describe("Labels applied to every selected account.");

const networksArg = z
  .record(z.string(), z.any())
  .optional()
  .describe(
    "Advanced: full per-network override map keyed by provider " +
      "(facebook, instagram, twitter, linkedin, pinterest, youtube, tiktok, " +
      "google, telegram, mastodon, threads, bluesky, wordpress_basic, " +
      "wordpress_oauth) for network-specific content. Bypasses auto-resolution.",
  );

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
        "Schedule a post across one or more social accounts. Returns a job_id; " +
        "poll publer_check_job_status until the job completes.",
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
        media: mediaArg,
        content_type: contentTypeArg,
        url: urlArg,
        labels: labelsArg,
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
        networks: networksArg,
        workspace_id: workspaceArg,
      },
    },
    async ({
      text,
      account_ids,
      scheduled_at,
      media,
      content_type,
      url,
      labels,
      state,
      auto,
      range,
      share_next,
      recycling,
      recurring,
      networks,
      workspace_id,
    }) => {
      try {
        const result = await client.createPosts(
          state,
          {
            text,
            accountIds: account_ids,
            media,
            scheduledAt: scheduled_at,
            contentType: content_type,
            url,
            labels,
            auto,
            range,
            shareNext: share_next,
            recycling,
            recurring,
            networks,
          },
          { workspaceId: workspace_id },
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
        "Publish a post immediately to one or more social accounts. Returns a " +
        "job_id; poll publer_check_job_status until the job completes.",
      inputSchema: {
        text: z.string().min(1).describe("The post body / caption text."),
        account_ids: accountIdsArg,
        media: mediaArg,
        content_type: contentTypeArg,
        url: urlArg,
        labels: labelsArg,
        networks: networksArg,
        workspace_id: workspaceArg,
      },
    },
    async ({
      text,
      account_ids,
      media,
      content_type,
      url,
      labels,
      networks,
      workspace_id,
    }) => {
      try {
        const result = await client.createPosts(
          "scheduled",
          {
            text,
            accountIds: account_ids,
            media,
            contentType: content_type,
            url,
            labels,
            networks,
          },
          { publish: true, workspaceId: workspace_id },
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
        "publer_check_job_status until the job completes.",
      inputSchema: {
        text: z.string().min(1).describe("The post body / caption text."),
        account_ids: accountIdsArg,
        media: mediaArg,
        content_type: contentTypeArg,
        url: urlArg,
        labels: labelsArg,
        visibility: z
          .enum(["public", "private"])
          .default("public")
          .describe(
            "public: visible to the workspace. private: only the creator.",
          ),
        networks: networksArg,
        workspace_id: workspaceArg,
      },
    },
    async ({
      text,
      account_ids,
      media,
      content_type,
      url,
      labels,
      visibility,
      networks,
      workspace_id,
    }) => {
      try {
        const result = await client.createPosts(
          visibility === "private" ? "draft_private" : "draft_public",
          {
            text,
            accountIds: account_ids,
            media,
            contentType: content_type,
            url,
            labels,
            networks,
          },
          { workspaceId: workspace_id },
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

  server.registerTool(
    "publer_get_post_insights",
    {
      title: "Get Publer post insights",
      description:
        "Retrieve performance analytics for published posts of a social " +
        "account, with filtering, sorting and pagination.",
      inputSchema: {
        account_id: z
          .string()
          .min(1)
          .describe("The social account ID to fetch post insights for."),
        from: z
          .string()
          .optional()
          .describe("Start date (YYYY-MM-DD) inclusive."),
        to: z
          .string()
          .optional()
          .describe("End date (YYYY-MM-DD) inclusive."),
        post_type: z
          .string()
          .optional()
          .describe(
            "Filter by post type, e.g. photo, video, reel, carousel, link, " +
              "status, story, short, document, article, poll.",
          ),
        query: z
          .string()
          .optional()
          .describe("Free-text search across post content."),
        labels: z
          .string()
          .optional()
          .describe("Comma-separated label filter."),
        sort: z
          .string()
          .optional()
          .describe(
            "Sort field, e.g. scheduled_at, reach, engagement, " +
              "engagement_rate, likes, comments, shares, saves, link_clicks.",
          ),
        page: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-based page index. Each page returns 10 posts."),
        competitors: z
          .boolean()
          .optional()
          .describe("Set true to enable competitor mode."),
        competitor_id: z
          .string()
          .optional()
          .describe("Narrow competitor mode to a single competitor."),
        workspace_id: workspaceArg,
      },
    },
    async ({ account_id, workspace_id, ...filters }) => {
      try {
        return ok(
          await client.getPostInsights(account_id, filters, workspace_id),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}
