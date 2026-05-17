import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { PublerConfig } from "./config.js";

const MAX_DIRECT_UPLOAD_BYTES = 200 * 1024 * 1024;

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

export interface MediaThumbnail {
  id?: string;
  small?: string;
  real?: string;
}

/** A reference to media already uploaded to Publer, used inside a post. */
export interface MediaRef {
  id: string;
  /** image | video | document. Inferred from content type when omitted. */
  type?: string;
  alt_text?: string;
  /** Video posts: video title. */
  title?: string;
  /** Video posts: thumbnail objects from the upload / list-media response. */
  thumbnails?: MediaThumbnail[];
  /** Video posts: 0-based index selecting the default thumbnail. */
  default_thumbnail?: number;
}

/** Rich link-preview metadata for link posts. */
export interface LinkMeta {
  url: string;
  title?: string;
  description?: string;
  images?: string[];
  default_image?: number;
  call_to_action?: string;
  provider_display?: string;
  phone_number?: string;
  original_title?: string;
  original_description?: string;
  original_images?: string[];
}

export interface SimplePostInput {
  text: string;
  accountIds: string[];
  media?: MediaRef[];
  /** ISO 8601 timestamp, applied inside every selected account object. */
  scheduledAt?: string;
  /** Labels applied to every selected account object. */
  labels?: string[];
  /** status | photo | video | link | gif | poll | carousel | pdf. Inferred when omitted. */
  contentType?: string;
  /** Link-preview metadata. Set this for link posts. */
  link?: LinkMeta;
  /**
   * Extra fields merged into every auto-built network block. Use for
   * content-type-specific fields, e.g. poll { options, duration, question },
   * reel { details: { type: "reel" } }.
   */
  extra?: Record<string, unknown>;
  /** Advanced: full per-network override map passed straight through. Bypasses provider auto-resolution. */
  networks?: Record<string, unknown>;
  /** Per-account fields, applied to every selected account object. */
  signature?: string;
  watermark?: Record<string, unknown>;
  location?: Record<string, unknown>;
  share?: Record<string, unknown>;
  comments?: unknown[];
  delete?: Record<string, unknown>;
  /** Extra fields merged into every selected account object. */
  accountExtra?: Record<string, unknown>;
  /** Post-level publishing options passed straight through. */
  auto?: boolean;
  range?: Record<string, unknown>;
  /** Auto-scheduling: schedule in the very next available slot. */
  shareNext?: boolean;
  recycling?: Record<string, unknown>;
  recurring?: Record<string, unknown>;
}

interface PublerAccount {
  id: string | number;
  provider?: string;
}

export interface MediaFromUrlItem {
  url: string;
  name: string;
  caption?: string;
  source?: string;
}

export type QueryValue = string | number | boolean | string[] | undefined;

interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  formData?: FormData;
  form?: Record<string, string>;
  workspaceId?: string;
}

/** Thin HTTP wrapper around the Publer API v1. */
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
        if (value === undefined || value === null || value === "") {
          continue;
        }
        if (Array.isArray(value)) {
          // Rails-style array params: key[]=a&key[]=b
          for (const item of value) {
            url.searchParams.append(`${key}[]`, String(item));
          }
        } else {
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

    let payload: string | FormData | undefined;
    if (options.formData !== undefined) {
      // Let fetch set the multipart Content-Type (with boundary).
      payload = options.formData;
    } else if (options.form !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(options.form).toString();
    } else if (options.body !== undefined) {
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
      let message = `Publer API ${method} ${path} failed with HTTP ${response.status}`;
      if (response.status === 429) {
        const reset = response.headers.get("X-RateLimit-Reset");
        const remaining = response.headers.get("X-RateLimit-Remaining");
        const resetHint = reset
          ? ` Window resets at ${new Date(
              Number(reset) * 1000,
            ).toISOString()} (X-RateLimit-Reset=${reset}).`
          : "";
        message +=
          ` Rate limit exceeded (X-RateLimit-Remaining=${remaining ?? "0"}).` +
          `${resetHint} Retry after the window resets.`;
      }
      throw new PublerApiError(response.status, parsed, message);
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

  /** Build `/analytics/{id}/{suffix}` or `/analytics/{suffix}` when id is omitted. */
  private analyticsPath(suffix: string, accountId?: string): string {
    return accountId
      ? `/analytics/${encodeURIComponent(accountId)}/${suffix}`
      : `/analytics/${suffix}`;
  }

  listPosts(
    query: Record<string, QueryValue>,
    workspaceId?: string,
  ): Promise<unknown> {
    return this.request("GET", "/posts", { query, workspaceId });
  }

  listMedia(
    query: Record<string, QueryValue>,
    workspaceId?: string,
  ): Promise<unknown> {
    return this.request("GET", "/media", { query, workspaceId });
  }

  listCharts(
    accountType?: string,
    workspaceId?: string,
  ): Promise<unknown> {
    return this.request("GET", "/analytics/charts", {
      query: accountType ? { account_type: accountType } : undefined,
      workspaceId,
    });
  }

  getChartData(
    query: Record<string, QueryValue>,
    accountId?: string,
    workspaceId?: string,
  ): Promise<unknown> {
    return this.request("GET", this.analyticsPath("chart_data", accountId), {
      query,
      workspaceId,
    });
  }

  getPostInsights(
    query: Record<string, QueryValue>,
    accountId?: string,
    workspaceId?: string,
  ): Promise<unknown> {
    return this.request(
      "GET",
      this.analyticsPath("post_insights", accountId),
      { query, workspaceId },
    );
  }

  getHashtagInsights(
    query: Record<string, QueryValue>,
    accountId?: string,
    workspaceId?: string,
  ): Promise<unknown> {
    return this.request(
      "GET",
      this.analyticsPath("hashtag_insights", accountId),
      { query, workspaceId },
    );
  }

  getHashtagPerformingPosts(
    query: Record<string, QueryValue>,
    accountId?: string,
    workspaceId?: string,
  ): Promise<unknown> {
    return this.request(
      "GET",
      this.analyticsPath("hashtag_performing_posts", accountId),
      { query, workspaceId },
    );
  }

  getBestTimes(
    query: Record<string, QueryValue>,
    accountId?: string,
    workspaceId?: string,
  ): Promise<unknown> {
    return this.request(
      "GET",
      this.analyticsPath("best_times", accountId),
      { query, workspaceId },
    );
  }

  getMembersAnalytics(
    query: Record<string, QueryValue>,
    workspaceId?: string,
  ): Promise<unknown> {
    return this.request("GET", "/analytics/members", { query, workspaceId });
  }

  listCompetitors(
    accountId?: string,
    workspaceId?: string,
  ): Promise<unknown> {
    const path = accountId
      ? `/competitors/${encodeURIComponent(accountId)}`
      : "/competitors";
    return this.request("GET", path, { workspaceId });
  }

  getCompetitorAnalytics(
    query: Record<string, QueryValue>,
    accountId?: string,
    workspaceId?: string,
  ): Promise<unknown> {
    const path = accountId
      ? `/competitors/${encodeURIComponent(accountId)}/analytics`
      : "/competitors/analytics";
    return this.request("GET", path, { query, workspaceId });
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
    const hasMedia = !!input.media && input.media.length > 0;
    const contentType =
      input.contentType ??
      (input.link ? "link" : hasMedia ? "photo" : "status");

    const block: Record<string, unknown> = {
      type: contentType,
      text: input.text,
      ...(input.extra ?? {}),
    };
    if (input.link) {
      block.link = input.link;
    }
    if (hasMedia) {
      const defaultType =
        contentType === "photo" || contentType === "carousel"
          ? "image"
          : contentType === "pdf"
            ? "document"
            : undefined;
      block.media = input.media!.map((m) => {
        const item: Record<string, unknown> = { ...m };
        if (item.type == null && defaultType) {
          item.type = defaultType;
        }
        return item;
      });
    }

    let networks: Record<string, unknown>;
    if (input.networks && Object.keys(input.networks).length > 0) {
      networks = input.networks;
    } else {
      const providers = await this.resolveAccountProviders(
        input.accountIds,
        options.workspaceId,
      );
      networks = {};
      for (const provider of new Set(providers.values())) {
        networks[provider] = block;
      }
    }

    const account = (id: string): Record<string, unknown> => ({
      id,
      ...(input.scheduledAt ? { scheduled_at: input.scheduledAt } : {}),
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.signature ? { signature: input.signature } : {}),
      ...(input.watermark ? { watermark: input.watermark } : {}),
      ...(input.location ? { location: input.location } : {}),
      ...(input.share ? { share: input.share } : {}),
      ...(input.comments ? { comments: input.comments } : {}),
      ...(input.delete ? { delete: input.delete } : {}),
      ...(input.accountExtra ?? {}),
    });

    const post: Record<string, unknown> = {
      networks,
      accounts: input.accountIds.map(account),
    };
    if (input.auto !== undefined) post.auto = input.auto;
    if (input.range) post.range = input.range;
    if (input.shareNext !== undefined) post.share_next = input.shareNext;
    if (input.recycling) post.recycling = input.recycling;
    if (input.recurring) post.recurring = input.recurring;

    return this.createPostsRaw(
      { state, posts: [post] },
      options,
    );
  }

  /**
   * Send a fully-formed `bulk` payload verbatim. Use this for advanced
   * features (multi-post batches, per-account share/comments/delete,
   * network-specific content, recycling/recurring) not covered by the
   * ergonomic post tools.
   */
  createPostsRaw(
    bulk: Record<string, unknown>,
    options: { publish?: boolean; workspaceId?: string } = {},
  ): Promise<unknown> {
    const path = options.publish
      ? "/posts/schedule/publish"
      : "/posts/schedule";
    return this.request("POST", path, {
      body: { bulk },
      workspaceId: options.workspaceId,
    });
  }

  /**
   * Delete one or more posts of any state. Subject to Publer's role-based
   * and state-specific authorization rules. Returns the deleted IDs.
   */
  deletePosts(postIds: string[], workspaceId?: string): Promise<unknown> {
    return this.request("DELETE", "/posts", {
      query: { post_ids: postIds },
      workspaceId,
    });
  }

  /** Extract rich link-preview metadata (title, description, images) from a URL. */
  extractLinkMetadata(url: string, workspaceId?: string): Promise<unknown> {
    return this.request("POST", "/posts/links", {
      form: { url },
      workspaceId,
    });
  }

  /** List signatures available for the given accounts in a workspace. */
  listSignatures(
    workspaceId: string,
    accountIds?: string[],
  ): Promise<unknown> {
    return this.request(
      "GET",
      `/workspaces/${encodeURIComponent(workspaceId)}/signatures`,
      { query: accountIds ? { accounts: accountIds } : undefined },
    );
  }

  /** Search locations to tag (Facebook, Instagram, or Threads). */
  searchLocations(
    network: "facebook" | "instagram" | "threads",
    query: string,
    workspaceId?: string,
  ): Promise<unknown> {
    return this.request("GET", `/locations/${network}`, {
      query: { q: query },
      workspaceId,
    });
  }

  /** List Facebook albums / Pinterest boards / saved watermarks per account. */
  getMediaOptions(
    workspaceId: string,
    accountIds?: string[],
  ): Promise<unknown> {
    return this.request(
      "GET",
      `/workspaces/${encodeURIComponent(workspaceId)}/media_options`,
      { query: accountIds ? { accounts: accountIds } : undefined },
    );
  }

  /** Update an existing post by ID. Body is wrapped as { post: {...} }. */
  updatePost(
    id: string,
    post: Record<string, unknown>,
    workspaceId?: string,
  ): Promise<unknown> {
    return this.request("PUT", `/posts/${encodeURIComponent(id)}`, {
      body: { post },
      workspaceId,
    });
  }

  /**
   * Upload a local media file directly (multipart, synchronous).
   * Returns the media object including the `id` to reference in posts.
   */
  async uploadMediaFile(
    filePath: string,
    options: {
      directUpload?: boolean;
      inLibrary?: boolean;
      workspaceId?: string;
    } = {},
  ): Promise<unknown> {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }
    if (fileStat.size > MAX_DIRECT_UPLOAD_BYTES) {
      throw new Error(
        `File is ${(fileStat.size / 1024 / 1024).toFixed(1)}MB; direct ` +
          `uploads are capped at 200MB. Use publer_upload_media_from_url ` +
          `for larger files.`,
      );
    }

    const blob = await openAsBlob(filePath);
    const form = new FormData();
    form.append("file", blob, basename(filePath));
    form.append("direct_upload", String(options.directUpload ?? false));
    form.append("in_library", String(options.inLibrary ?? false));

    return this.request("POST", "/media", {
      formData: form,
      workspaceId: options.workspaceId,
    });
  }

  /**
   * Import media by URL (asynchronous). Returns a `job_id`; poll job status
   * to get the resulting media.
   */
  async uploadMediaFromUrl(
    media: MediaFromUrlItem[],
    options: {
      type?: string;
      directUpload?: boolean;
      inLibrary?: boolean;
      workspaceId?: string;
    } = {},
  ): Promise<unknown> {
    return this.request("POST", "/media/from-url", {
      body: {
        media,
        type: options.type ?? "single",
        direct_upload: options.directUpload ?? false,
        in_library: options.inLibrary ?? false,
      },
      workspaceId: options.workspaceId,
    });
  }
}
