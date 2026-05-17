#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  // stdout is reserved for the MCP protocol; log diagnostics to stderr.
  console.error("Fatal error starting Publer MCP server:", error);
  process.exit(1);
});
