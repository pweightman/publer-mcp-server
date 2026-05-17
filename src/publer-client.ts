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
  /** Publer content type for the network block. Defaults to status, or photo when media is attached. */
  type?: string;
  /** Advanced: full per-network override map passed straight through, bypassing provider auto-resolution. */
  networks?: Record<string, unknown>;
}

interface PublerAccount {
  id: string | number;
  provider?: string;
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

  private async resolveAccountProviders(
    accountIds: string[],
    workspaceId?: string,
  ): Promise<Map<string, string>> {
    const raw = (await this.listAccounts(workspaceId)) as
      | PublerAccount[]
      | { accounts?: PublerAccount[] }
      | null;

    const accounts: PublerAccount[] = Array.isArray(raw)
      ? raw
      : (raw?.accounts ?? []);

    const byId = new Map<string, string>();
    for (const account of accounts) {
      if (account?.id != null && account.provider) {
        byId.set(String(account.id), String(account.provider));
      }
    }

    const unresolved = accountIds.filter((id) => !byId.has(id));
    if (unresolved.length > 0) {
      const ws = workspaceId ?? this.config.workspaceId ?? "(default)";
      throw new Error(
        `Could not determine the social network for account id(s): ` +
          `${unresolved.join(", ")}. Verify them with publer_list_accounts ` +
          `and that they belong to workspace ${ws}.`,
      );
    }
    return byId;
  }

  async createPosts(
    state: PostState,
    input: SimplePostInput,
    options: { publish?: boolean; workspaceId?: string } = {},
  ): Promise<unknown> {
    let networks: Record<string, unknown>;
    if (input.networks && Object.keys(input.networks).length > 0) {
      networks = input.networks;
    } else {
      const providers = await this.resolveAccountProviders(
        input.accountIds,
        options.workspaceId,
      );
      const type =
        input.type ??
        (input.mediaUrls && input.mediaUrls.length > 0 ? "photo" : "status");
      const media =
        input.mediaUrls && input.mediaUrls.length > 0
          ? input.mediaUrls.map((path) => ({ path }))
          : undefined;

      networks = {};
      for (const provider of new Set(providers.values())) {
        networks[provider] = {
          type,
          text: input.text,
          ...(media ? { media } : {}),
        };
      }
    }

    const post: Record<string, unknown> = {
      networks,
      accounts: input.accountIds.map((id) => ({ id })),
    };
    if (input.scheduledAt) {
      post.scheduled_at = input.scheduledAt;
    }

    const path = options.publish
      ? "/posts/schedule/publish"
      : "/posts/schedule";
    return this.request("POST", path, {
      body: { bulk: { state, posts: [post] } },
      workspaceId: options.workspaceId,
    });
  }
}
