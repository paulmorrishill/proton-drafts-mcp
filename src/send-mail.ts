import nodemailer from "nodemailer";
import { BridgeCredentials } from "./credentials.js";
import { fetchDraftSource, deleteDraft } from "./imap-client.js";

export interface SendDraftResult {
  uid: number;
  draftsPath: string;
  deleted: boolean;
  messageId?: string;
  accepted: string[];
  rejected: string[];
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

export async function sendDraft(
  creds: BridgeCredentials,
  uid: number,
  opts: { deleteAfter?: boolean } = {}
): Promise<SendDraftResult> {
  const { source, draftsPath } = await fetchDraftSource(creds, uid);
  const transporter = smtpTransport(creds);
  try {
    const info = await transporter.sendMail({ raw: source });
    const deleteAfter = opts.deleteAfter !== false;
    if (deleteAfter) {
      try {
        await deleteDraft(creds, uid);
      } catch (err) {
        // Send succeeded; deletion failed. Surface in result but don't fail the call.
        return {
          uid,
          draftsPath,
          deleted: false,
          messageId: info.messageId,
          accepted: (info.accepted ?? []) as string[],
          rejected: (info.rejected ?? []) as string[],
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
    };
  } finally {
    transporter.close();
  }
}
