import type { PublerConfig } from "./config.js";

export class PublerApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "PublerApiError";
    this.status = status;
    this.body = body;
  }
}

export type PostState =
  | "scheduled"
  | "auto_scheduled"
  | "recycled"
  | "recurring"
  | "draft"
  | "draft_public"
  | "draft_private";

export interface SimplePostInput {
  text: string;
  accountIds: string[];
  mediaUrls?: string[];
  scheduledAt?: string;
  /** Advanced per-network overrides passed straight through to the Publer payload. */
  networks?: Record<string, unknown>;
}

type QueryValue = string | number | boolean | undefined;

interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  workspaceId?: string;
}

/**
 * Thin HTTP wrapper around the Publer API v1.
 *
 * The post-creation payload (the `bulk` envelope) is constructed in one place
 * (`buildBulkBody`) so it is easy to adjust if Publer changes the schema.
 */
export class PublerClient {
  constructor(private readonly config: PublerConfig) {}

  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(this.config.baseUrl + path);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer-API ${this.config.apiKey}`,
      Accept: "application/json",
    };

    const workspaceId = options.workspaceId ?? this.config.workspaceId;
    if (workspaceId) {
      headers["Publer-Workspace-Id"] = workspaceId;
    }

    let payload: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(options.body);
    }

    const response = await fetch(url, { method, headers, body: payload });
    const rawText = await response.text();

    let parsed: unknown;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = rawText;
      }
    }

    if (!response.ok) {
      throw new PublerApiError(
        response.status,
        parsed,
        `Publer API ${method} ${path} failed with HTTP ${response.status}`,
      );
    }

    return parsed as T;
  }

  getCurrentUser(workspaceId?: string): Promise<unknown> {
    return this.request("GET", "/users/me", { workspaceId });
  }

  listWorkspaces(): Promise<unknown> {
    return this.request("GET", "/workspaces");
  }

  listAccounts(workspaceId?: string): Promise<unknown> {
    return this.request("GET", "/accounts", { workspaceId });
  }

  getJobStatus(jobId: string, workspaceId?: string): Promise<unknown> {
    return this.request(
      "GET",
      `/job_status/${encodeURIComponent(jobId)}`,
      { workspaceId },
    );
  }

  getPostInsights(
    accountId: string,
    query: Record<string, QueryValue>,
    workspaceId?: string,
  ): Promise<unknown> {
    return this.request(
      "GET",
      `/analytics/${encodeURIComponent(accountId)}/post_insights`,
      { query, workspaceId },
    );
  }

  createPosts(
    state: PostState,
    input: SimplePostInput,
    options: { publish?: boolean; workspaceId?: string } = {},
  ): Promise<unknown> {
    const body = buildBulkBody(state, input);
    const path = options.publish
      ? "/posts/schedule/publish"
      : "/posts/schedule";
    return this.request("POST", path, {
      body,
      workspaceId: options.workspaceId,
    });
  }
}

export function buildBulkBody(state: PostState, input: SimplePostInput) {
  const post: Record<string, unknown> = {
    networks: input.networks ?? {},
    accounts: input.accountIds.map((id) => ({ id })),
    text: input.text,
  };

  if (input.mediaUrls && input.mediaUrls.length > 0) {
    post.media = input.mediaUrls.map((path) => ({ path }));
  }

  if (input.scheduledAt) {
    post.scheduled_at = input.scheduledAt;
  }

  return { bulk: { state, posts: [post] } };
}
