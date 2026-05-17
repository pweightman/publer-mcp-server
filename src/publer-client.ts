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
  scheduledAt?: string;
  /** Publer content type for the network block. Defaults to status, or photo when media is attached. */
  type?: string;
  /** Advanced: full per-network override map passed straight through. Bypasses the default network block. */
  networks?: Record<string, unknown>;
}

export interface MediaFromUrlItem {
  url: string;
  name: string;
  caption?: string;
  source?: string;
}

type QueryValue = string | number | boolean | undefined;

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

  async createPosts(
    state: PostState,
    input: SimplePostInput,
    options: { publish?: boolean; workspaceId?: string } = {},
  ): Promise<unknown> {
    let networks: Record<string, unknown>;
    if (input.networks && Object.keys(input.networks).length > 0) {
      networks = input.networks;
    } else {
      const hasMedia = !!input.media && input.media.length > 0;
      const block: Record<string, unknown> = {
        type: input.type ?? (hasMedia ? "photo" : "status"),
        text: input.text,
      };
      if (hasMedia) {
        block.media = input.media!.map((m) => ({
          id: m.id,
          type: m.type ?? "image",
          ...(m.alt_text ? { alt_text: m.alt_text } : {}),
        }));
      }
      // "default" applies the same content to every selected account/network.
      networks = { default: block };
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
