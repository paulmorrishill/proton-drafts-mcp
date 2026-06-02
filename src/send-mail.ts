import nodemailer from "nodemailer";
import { simpleParser, AddressObject } from "mailparser";
import { BridgeCredentials } from "./credentials.js";
import { fetchDraftSource, deleteDraft } from "./imap-client.js";
import { archiveSent } from "./archive.js";

export interface SendDraftResult {
  uid: number;
  draftsPath: string;
  deleted: boolean;
  messageId?: string;
  accepted: string[];
  rejected: string[];
  envelope: { from: string; to: string[] };
  archivedTo?: string;
}

function smtpTransport(creds: BridgeCredentials) {
  return nodemailer.createTransport({
    host: creds.host,
    port: creds.smtpPort ?? 1025,
    secure: creds.smtpSecure ?? false,
    auth: { user: creds.user, pass: creds.password },
    tls: { rejectUnauthorized: false },
  });
}

function flattenAddresses(field: AddressObject | AddressObject[] | undefined): string[] {
  if (!field) return [];
  const arr = Array.isArray(field) ? field : [field];
  const out: string[] = [];
  for (const a of arr) {
    for (const v of a.value ?? []) {
      if (v.address) out.push(v.address);
    }
  }
  return out;
}

export async function sendDraft(
  creds: BridgeCredentials,
  uid: number,
  opts: { deleteAfter?: boolean } = {}
): Promise<SendDraftResult> {
  const { source, draftsPath } = await fetchDraftSource(creds, uid);

  // Parse MIME to extract envelope. nodemailer's `raw` option does NOT auto-derive
  // SMTP envelope from headers — must supply it explicitly or RCPT TO is empty
  // and Bridge rejects.
  const parsed = await simpleParser(source);
  const fromAddrs = flattenAddresses(parsed.from);
  const toAddrs = flattenAddresses(parsed.to);
  const ccAddrs = flattenAddresses(parsed.cc);
  const bccAddrs = flattenAddresses(parsed.bcc);

  if (fromAddrs.length === 0) {
    throw new Error(`Draft UID ${uid}: no From address in MIME headers`);
  }
  const recipients = [...toAddrs, ...ccAddrs, ...bccAddrs];
  if (recipients.length === 0) {
    throw new Error(`Draft UID ${uid}: no To/Cc/Bcc recipients in MIME headers`);
  }

  const envelope = { from: fromAddrs[0], to: recipients };

  const transporter = smtpTransport(creds);
  try {
    const info = await transporter.sendMail({ envelope, raw: source });

    // Archive to disk for record keeping. Best-effort — do not fail send if archive fails.
    let archivedTo: string | undefined;
    try {
      const { emlPath } = await archiveSent(source, {
        uid,
        messageId: info.messageId,
        from: envelope.from,
        to: envelope.to,
        subject: parsed.subject,
        sentAt: new Date().toISOString(),
      });
      archivedTo = emlPath;
    } catch (err) {
      process.stderr.write(`[proton-drafts-mcp] Archive failed for UID ${uid}: ${(err as Error).message}\n`);
    }

    const deleteAfter = opts.deleteAfter !== false;
    if (deleteAfter) {
      try {
        await deleteDraft(creds, uid);
      } catch {
        // Send succeeded; deletion failed. Surface in result.
        return {
          uid,
          draftsPath,
          deleted: false,
          messageId: info.messageId,
          accepted: (info.accepted ?? []) as string[],
          rejected: (info.rejected ?? []) as string[],
          envelope,
          archivedTo,
        };
      }
    }
    return {
      uid,
      draftsPath,
      deleted: deleteAfter,
      messageId: info.messageId,
      accepted: (info.accepted ?? []) as string[],
      rejected: (info.rejected ?? []) as string[],
      envelope,
      archivedTo,
    };
  } finally {
    transporter.close();
  }
}
