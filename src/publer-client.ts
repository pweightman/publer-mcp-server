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

/** A reference to media already uploaded to Publer, used inside a post. */
export interface MediaRef {
  id: string;
  /** image | video | document. Defaults to image. */
  type?: string;
  alt_text?: string;
}

export interface SimplePostInput {
  text: string;
  accountIds: string[];
  media?: MediaRef[];
  /** ISO 8601 timestamp, applied inside every selected account object. */
  scheduledAt?: string;
  /** Labels applied to every selected account object. */
  labels?: string[];
  /** status | photo | video | link | carousel | pdf. Inferred when omitted. */
  contentType?: string;
  /** Required for link posts. */
  url?: string;
  /** Advanced: full per-network override map passed straight through. Bypasses provider auto-resolution. */
  networks?: Record<string, unknown>;
  /** Post-level publishing options passed straight through. */
  auto?: boolean;
  range?: Record<string, unknown>;
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

type QueryValue = string | number | boolean | string[] | undefined;

interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  formData?: FormData;
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
    const hasMedia = !!input.media && input.media.length > 0;
    const contentType =
      input.contentType ??
      (input.url ? "link" : hasMedia ? "photo" : "status");

    const block: Record<string, unknown> = {
      type: contentType,
      text: input.text,
    };
    if (input.url) {
      block.url = input.url;
    }
    if (hasMedia) {
      block.media = input.media!.map((m) => ({
        id: m.id,
        type: m.type ?? "image",
        ...(m.alt_text ? { alt_text: m.alt_text } : {}),
      }));
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
    });

    const post: Record<string, unknown> = {
      networks,
      accounts: input.accountIds.map(account),
    };
    if (input.auto !== undefined) post.auto = input.auto;
    if (input.range) post.range = input.range;
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
