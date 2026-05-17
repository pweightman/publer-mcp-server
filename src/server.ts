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

const mediaUrlsArg = z
  .array(z.string().url())
  .optional()
  .describe("Optional list of publicly accessible media URLs to attach.");

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
          .describe(
            "ISO 8601 timestamp for when to publish, e.g. 2026-06-01T09:00:00Z. " +
              "Required for state=scheduled.",
          ),
        media_urls: mediaUrlsArg,
        state: z
          .enum(["scheduled", "auto_scheduled", "recycled", "recurring"])
          .default("scheduled")
          .describe("Publishing method. Defaults to scheduled."),
        networks: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "Advanced: per-network content overrides passed straight through " +
              "to the Publer payload (keyed by provider).",
          ),
        workspace_id: workspaceArg,
      },
    },
    async ({
      text,
      account_ids,
      scheduled_at,
      media_urls,
      state,
      networks,
      workspace_id,
    }) => {
      try {
        const result = await client.createPosts(
          state,
          {
            text,
            accountIds: account_ids,
            mediaUrls: media_urls,
            scheduledAt: scheduled_at,
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
        media_urls: mediaUrlsArg,
        networks: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "Advanced: per-network content overrides keyed by provider.",
          ),
        workspace_id: workspaceArg,
      },
    },
    async ({ text, account_ids, media_urls, networks, workspace_id }) => {
      try {
        const result = await client.createPosts(
          "scheduled",
          {
            text,
            accountIds: account_ids,
            mediaUrls: media_urls,
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
        media_urls: mediaUrlsArg,
        visibility: z
          .enum(["public", "private"])
          .default("public")
          .describe(
            "public: visible to the workspace. private: only the creator.",
          ),
        workspace_id: workspaceArg,
      },
    },
    async ({ text, account_ids, media_urls, visibility, workspace_id }) => {
      try {
        const result = await client.createPosts(
          visibility === "private" ? "draft_private" : "draft_public",
          {
            text,
            accountIds: account_ids,
            mediaUrls: media_urls,
          },
          { workspaceId: workspace_id },
        );
        return ok(result);
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
        "Poll the status of an asynchronous post job. Post-creation tools " +
        "return a job_id; call this until status is complete to see successes " +
        "and failures.",
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
