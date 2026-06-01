import { ImapFlow } from "imapflow";
import { BridgeCredentials } from "./credentials.js";

export interface DraftInput {
  to: string;
  subject: string;
  body: string;
  isHtml?: boolean;
  cc?: string;
  bcc?: string;
  from?: string;
}

function buildMime(input: DraftInput, defaultFrom: string): string {
  const from = input.from || defaultFrom;
  const boundary = "----=_proton_drafts_mcp_" + Math.floor(performance.now() * 1000).toString(36);
  const date = new Date().toUTCString();
  const headers: string[] = [
    `From: ${from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
  ];
  if (input.cc) headers.push(`Cc: ${input.cc}`);
  if (input.bcc) headers.push(`Bcc: ${input.bcc}`);

  if (input.isHtml) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const text = input.body.replace(/<[^>]+>/g, "");
    return (
      headers.join("\r\n") +
      "\r\n\r\n" +
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n\r\n` +
      text +
      `\r\n--${boundary}\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n\r\n` +
      input.body +
      `\r\n--${boundary}--\r\n`
    );
  }
  headers.push(`Content-Type: text/plain; charset=utf-8`);
  headers.push(`Content-Transfer-Encoding: 8bit`);
  return headers.join("\r\n") + "\r\n\r\n" + input.body + "\r\n";
}

async function findDraftsMailbox(client: ImapFlow): Promise<string> {
  const list = await client.list();
  const draft = list.find(
    (m) => m.specialUse === "\\Drafts" || /^drafts?$/i.test(m.name) || /^drafts?$/i.test(m.path)
  );
  if (!draft) throw new Error("Could not find Drafts mailbox");
  return draft.path;
}

export async function createDraft(creds: BridgeCredentials, input: DraftInput): Promise<{ uid?: number; path: string }> {
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.user, pass: creds.password },
    logger: false,
    tls: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const draftsPath = await findDraftsMailbox(client);
    const mime = buildMime(input, creds.user);
    const result = await client.append(draftsPath, mime, ["\\Draft"], new Date());
    return { uid: typeof result === "object" && result ? (result as { uid?: number }).uid : undefined, path: draftsPath };
  } finally {
    await client.logout().catch(() => {});
  }
}
