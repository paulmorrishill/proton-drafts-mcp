import { ImapFlow, SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import { BridgeCredentials, isReadAllowed, anyReadAllowed } from "./credentials.js";

function newClient(creds: BridgeCredentials): ImapFlow {
  return new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.user, pass: creds.password },
    logger: false,
    tls: { rejectUnauthorized: false },
  });
}

function addrList(arr: { address?: string; name?: string }[] | undefined): string {
  if (!arr) return "";
  return arr
    .map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : a.address ?? ""))
    .filter(Boolean)
    .join(", ");
}

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
  const client = newClient(creds);
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

export interface EmailSummary {
  uid: number;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  date: string;
  snippet: string;
  flags: string[];
  seen: boolean;
}

export interface EmailDetail extends EmailSummary {
  body: string;
  bodyHtml?: string;
  headers: Record<string, string>;
}

export interface ListEmailsOptions {
  to: string;
  folder?: string;
  limit?: number;
  since?: Date;
  unseenOnly?: boolean;
}

function matchesAddress(envelopeAddrs: { address?: string }[] | undefined, target: string): boolean {
  if (!envelopeAddrs) return false;
  const t = target.toLowerCase();
  return envelopeAddrs.some((a) => (a.address ?? "").toLowerCase() === t);
}

export async function listEmails(creds: BridgeCredentials, opts: ListEmailsOptions): Promise<EmailSummary[]> {
  if (!isReadAllowed(creds, opts.to)) {
    throw new Error(
      `Address "${opts.to}" is not in the read whitelist. Use open_settings to add it.`
    );
  }
  const client = newClient(creds);
  await client.connect();
  try {
    const folder = opts.folder || "INBOX";
    // readOnly: true → server issues EXAMINE, will not update \Seen flags
    await client.mailboxOpen(folder, { readOnly: true });

    const criteria: SearchObject = { to: opts.to };
    if (opts.since) criteria.since = opts.since;
    if (opts.unseenOnly) criteria.seen = false;

    const uids = await client.search(criteria, { uid: true });
    if (!uids || uids.length === 0) return [];

    const limit = Math.min(opts.limit ?? 50, uids.length);
    // newest UIDs are last; reverse so newest first
    const picked = uids.slice(-limit).reverse();

    const results: EmailSummary[] = [];
    for await (const msg of client.fetch(picked, {
      uid: true,
      envelope: true,
      flags: true,
      internalDate: true,
      bodyParts: ["TEXT"],
    }, { uid: true })) {
      const env = msg.envelope;
      // Post-filter: confirm target appears in To envelope (defence in depth — some IMAP servers
      // search loosely)
      if (!matchesAddress(env?.to, opts.to)) continue;

      let snippet = "";
      const textPart = msg.bodyParts?.get("TEXT");
      if (textPart) {
        try {
          const parsed = await simpleParser(textPart);
          snippet = (parsed.text || "").replace(/\s+/g, " ").trim().slice(0, 240);
        } catch {
          snippet = textPart.toString("utf-8").replace(/\s+/g, " ").trim().slice(0, 240);
        }
      }

      const flags = Array.from(msg.flags ?? []);
      results.push({
        uid: msg.uid,
        from: addrList(env?.from),
        to: addrList(env?.to),
        cc: env?.cc?.length ? addrList(env.cc) : undefined,
        subject: env?.subject ?? "",
        date: new Date(env?.date ?? msg.internalDate ?? new Date()).toISOString(),
        snippet,
        flags,
        seen: flags.includes("\\Seen"),
      });
    }
    return results;
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function getEmail(
  creds: BridgeCredentials,
  uid: number,
  folder: string = "INBOX"
): Promise<EmailDetail | null> {
  const client = newClient(creds);
  await client.connect();
  try {
    await client.mailboxOpen(folder, { readOnly: true });
    const msg = await client.fetchOne(
      String(uid),
      { uid: true, envelope: true, flags: true, internalDate: true, source: true, headers: true },
      { uid: true }
    );
    if (!msg) return null;
    const env = msg.envelope;
    const toAddresses = (env?.to ?? []).map((a) => a.address ?? "").filter(Boolean);
    if (!anyReadAllowed(creds, toAddresses)) {
      throw new Error(
        `Message UID ${uid} addressed to [${toAddresses.join(", ")}] — none match the read whitelist.`
      );
    }
    const parsed = await simpleParser(msg.source as Buffer);

    const headers: Record<string, string> = {};
    if (msg.headers) {
      const headerStr = msg.headers.toString("utf-8");
      for (const line of headerStr.split(/\r?\n/)) {
        const idx = line.indexOf(":");
        if (idx > 0) {
          const key = line.slice(0, idx).trim().toLowerCase();
          const val = line.slice(idx + 1).trim();
          if (key && val) headers[key] = headers[key] ? headers[key] + "; " + val : val;
        }
      }
    }

    const text = parsed.text || "";
    const flags = Array.from(msg.flags ?? []);
    return {
      uid: msg.uid,
      from: addrList(env?.from),
      to: addrList(env?.to),
      cc: env?.cc?.length ? addrList(env.cc) : undefined,
      subject: env?.subject ?? "",
      date: new Date(env?.date ?? msg.internalDate ?? new Date()).toISOString(),
      snippet: text.replace(/\s+/g, " ").trim().slice(0, 240),
      body: text,
      bodyHtml: typeof parsed.html === "string" ? parsed.html : undefined,
      headers,
      flags,
      seen: flags.includes("\\Seen"),
    };
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function listFolders(creds: BridgeCredentials): Promise<{ path: string; name: string; specialUse?: string }[]> {
  const client = newClient(creds);
  await client.connect();
  try {
    const list = await client.list();
    return list.map((m) => ({ path: m.path, name: m.name, specialUse: m.specialUse }));
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function fetchDraftSource(
  creds: BridgeCredentials,
  uid: number
): Promise<{ source: Buffer; draftsPath: string }> {
  const client = newClient(creds);
  await client.connect();
  try {
    const draftsPath = await findDraftsMailbox(client);
    await client.mailboxOpen(draftsPath, { readOnly: true });
    const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error(`Draft UID ${uid} not found in ${draftsPath}`);
    return { source: msg.source as Buffer, draftsPath };
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function deleteDraft(creds: BridgeCredentials, uid: number): Promise<void> {
  const client = newClient(creds);
  await client.connect();
  try {
    const draftsPath = await findDraftsMailbox(client);
    await client.mailboxOpen(draftsPath);
    await client.messageFlagsAdd(String(uid), ["\\Deleted"], { uid: true });
    try {
      await client.mailboxClose();
    } catch {
      // ignore
    }
  } finally {
    await client.logout().catch(() => {});
  }
}
