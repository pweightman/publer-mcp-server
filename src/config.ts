export interface PublerConfig {
  apiKey: string;
  workspaceId?: string;
  baseUrl: string;
}

const DEFAULT_BASE_URL = "https://app.publer.com/api/v1";

export function loadConfig(): PublerConfig {
  const apiKey = process.env.PUBLER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "PUBLER_API_KEY environment variable is required. Generate an API key in " +
        "Publer under Settings -> Access & Login -> API Keys.",
    );
  }

  const workspaceId = process.env.PUBLER_WORKSPACE_ID?.trim() || undefined;

  const baseUrl =
    process.env.PUBLER_API_BASE_URL?.trim().replace(/\/+$/, "") ||
    DEFAULT_BASE_URL;

  return { apiKey, workspaceId, baseUrl };
}
