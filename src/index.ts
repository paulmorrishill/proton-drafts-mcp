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
import { createDraft, listEmails, getEmail, listFolders } from "./imap-client.js";
import { sendDraft } from "./send-mail.js";

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
      name: "list_emails",
      description:
        "List emails sent TO a specific address (read-only — does NOT mark messages as read or alter state). Uses IMAP EXAMINE mode. Returns envelope + short snippet per message, newest first. Use this to find emails addressed to a particular alias/forwarding address before drilling into bodies with get_email.",
      inputSchema: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "Recipient email address to filter by. Only messages with this address in the To: header are returned.",
          },
          folder: { type: "string", description: "IMAP folder to search. Default: INBOX.", default: "INBOX" },
          limit: { type: "number", description: "Max messages to return. Default: 50.", default: 50 },
          since: { type: "string", description: "Only messages on or after this date (ISO 8601, e.g. 2026-05-01)." },
          unseenOnly: { type: "boolean", description: "If true, only return unread messages.", default: false },
        },
        required: ["to"],
      },
    },
    {
      name: "get_email",
      description:
        "Fetch full body + headers of one email by UID (read-only, no state change). Pair with list_emails: first list to get UIDs, then drill into specific messages for categorisation.",
      inputSchema: {
        type: "object",
        properties: {
          uid: { type: "number", description: "IMAP UID of the message (from list_emails)." },
          folder: { type: "string", description: "IMAP folder. Must match the folder used in list_emails. Default: INBOX.", default: "INBOX" },
        },
        required: ["uid"],
      },
    },
    {
      name: "list_folders",
      description: "List IMAP folders (mailboxes) available via Proton Bridge.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "send_draft",
      description:
        "Send an existing draft (by UID) via Proton Bridge SMTP. The draft's From/To/Subject/body are used verbatim. After successful send Proton auto-saves a copy to the Sent folder. The Drafts copy is deleted unless deleteAfter=false.",
      inputSchema: {
        type: "object",
        properties: {
          uid: { type: "number", description: "IMAP UID of the draft in the Drafts folder (returned by create_draft)." },
          deleteAfter: { type: "boolean", description: "Delete the draft from Drafts after sending. Default: true.", default: true },
        },
        required: ["uid"],
      },
    },
    {
      name: "open_settings",
      description:
        "Open the browser-based settings page to update Bridge credentials, SMTP config, and the read whitelist. Blocks until the user submits the form.",
      inputSchema: { type: "object", properties: {} },
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

  if (name === "open_settings") {
    const updated = await runSetupFlow(loadCredentials());
    creds = updated;
    const count = updated.allowedReadAddresses?.length ?? 0;
    return {
      content: [
        {
          type: "text",
          text: `Settings saved. User: ${updated.user}. Read whitelist: ${count === 0 ? "(empty — all addresses allowed)" : count + " addresses"}.`,
        },
      ],
    };
  }

  if (!creds) creds = await ensureCredentials();
  const a = args as Record<string, unknown>;

  try {
    if (name === "create_draft") {
      if (typeof a.to !== "string" || typeof a.subject !== "string" || typeof a.body !== "string") {
        throw new McpError(ErrorCode.InvalidParams, "to, subject, body are required strings");
      }
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
          { type: "text", text: `Draft created in ${result.path}${result.uid ? ` (UID ${result.uid})` : ""}.` },
        ],
      };
    }

    if (name === "list_emails") {
      if (typeof a.to !== "string" || !a.to) {
        throw new McpError(ErrorCode.InvalidParams, "to is required");
      }
      const since = typeof a.since === "string" ? new Date(a.since) : undefined;
      if (since && Number.isNaN(since.getTime())) {
        throw new McpError(ErrorCode.InvalidParams, "since must be a valid ISO 8601 date");
      }
      const list = await listEmails(creds, {
        to: a.to,
        folder: typeof a.folder === "string" ? a.folder : undefined,
        limit: typeof a.limit === "number" ? a.limit : undefined,
        since,
        unseenOnly: typeof a.unseenOnly === "boolean" ? a.unseenOnly : false,
      });
      return { content: [{ type: "text", text: JSON.stringify({ count: list.length, messages: list }, null, 2) }] };
    }

    if (name === "get_email") {
      if (typeof a.uid !== "number") {
        throw new McpError(ErrorCode.InvalidParams, "uid (number) is required");
      }
      const folder = typeof a.folder === "string" ? a.folder : "INBOX";
      const msg = await getEmail(creds, a.uid, folder);
      if (!msg) {
        return { content: [{ type: "text", text: `No message with UID ${a.uid} in ${folder}.` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(msg, null, 2) }] };
    }

    if (name === "list_folders") {
      const folders = await listFolders(creds);
      return { content: [{ type: "text", text: JSON.stringify(folders, null, 2) }] };
    }

    if (name === "send_draft") {
      if (typeof a.uid !== "number") {
        throw new McpError(ErrorCode.InvalidParams, "uid (number) is required");
      }
      const result = await sendDraft(creds, a.uid, {
        deleteAfter: typeof a.deleteAfter === "boolean" ? a.deleteAfter : true,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  } catch (err) {
    if (err instanceof McpError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new McpError(ErrorCode.InternalError, `Failed: ${msg}`);
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
