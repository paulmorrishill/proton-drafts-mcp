import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const ARCHIVE_DIR = path.join(homedir(), ".proton-drafts-mcp", "sent");

export interface ArchiveMeta {
  uid: number;
  messageId?: string;
  from: string;
  to: string[];
  subject?: string;
  sentAt: string;
}

function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^_+|_+$/g, "");
}

export async function archiveSent(source: Buffer, meta: ArchiveMeta): Promise<{ emlPath: string; indexPath: string }> {
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  const stamp = meta.sentAt.replace(/[:.]/g, "-");
  const idPart = meta.messageId ? safeName(meta.messageId).slice(0, 80) : `uid-${meta.uid}`;
  const emlName = `${stamp}_${idPart}.eml`;
  const emlPath = path.join(ARCHIVE_DIR, emlName);
  await fs.writeFile(emlPath, source);

  const indexPath = path.join(ARCHIVE_DIR, "sent.jsonl");
  const entry = JSON.stringify({ ...meta, file: emlName }) + "\n";
  await fs.appendFile(indexPath, entry, "utf-8");
  return { emlPath, indexPath };
}
