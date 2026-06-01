#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { loadCredentials, deleteCredentials, BridgeCredentials } from "./credentials.js";
import { runSetupFlow } from "./setup-server.js";
import { createDraft } from "./imap-client.js";

async function ensureCredentials(): Promise<BridgeCredentials> {
  const existing = loadCredentials();
  if (existing) return existing;
  process.stderr.write("[proton-drafts-mcp] No credentials in Windows Credential Manager. Starting setup...\n");
  return runSetupFlow();
}

const server = new Server(
  { name: "proton-drafts-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

let creds: BridgeCredentials | null = null;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "create_draft",
      description:
        "Create a draft email in Proton Mail via Proton Bridge IMAP. Draft appears in the Drafts folder of Proton Mail web/mobile.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address(es), comma-separated" },
          subject: { type: "string", description: "Email subject" },
          body: { type: "string", description: "Email body (plain text or HTML)" },
          isHtml: { type: "boolean", description: "If true, body is HTML", default: false },
          cc: { type: "string", description: "CC recipient(s), comma-separated" },
          bcc: { type: "string", description: "BCC recipient(s), comma-separated" },
          from: { type: "string", description: "From address. Must be an address owned by your Proton account (alias, custom domain, @pm.me, etc). Defaults to the configured username." },
        },
        required: ["to", "subject", "body"],
      },
    },
    {
      name: "reset_credentials",
      description: "Delete stored Bridge credentials. Next request triggers the browser setup flow again.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "reset_credentials") {
    deleteCredentials();
    creds = null;
    return { content: [{ type: "text", text: "Credentials deleted. Next create_draft call will trigger setup." }] };
  }

  if (name !== "create_draft") {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  if (!creds) creds = await ensureCredentials();

  const a = args as Record<string, unknown>;
  if (typeof a.to !== "string" || typeof a.subject !== "string" || typeof a.body !== "string") {
    throw new McpError(ErrorCode.InvalidParams, "to, subject, body are required strings");
  }

  try {
    const result = await createDraft(creds, {
      to: a.to,
      subject: a.subject,
      body: a.body,
      isHtml: typeof a.isHtml === "boolean" ? a.isHtml : false,
      cc: typeof a.cc === "string" ? a.cc : undefined,
      bcc: typeof a.bcc === "string" ? a.bcc : undefined,
      from: typeof a.from === "string" ? a.from : undefined,
    });
    return {
      content: [
        {
          type: "text",
          text: `Draft created in ${result.path}${result.uid ? ` (UID ${result.uid})` : ""}.`,
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new McpError(ErrorCode.InternalError, `Failed to create draft: ${msg}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[proton-drafts-mcp] Server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`[proton-drafts-mcp] Fatal: ${err}\n`);
  process.exit(1);
});
