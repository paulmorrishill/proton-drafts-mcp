#!/usr/bin/env node
// One-shot backfill: scan Sent folder, archive messages whose recipient
// matches one of the addresses given on the command line.
//
// Usage:
//   node scripts/backfill-sent.mjs <to-address> [<to-address> ...]
//   node scripts/backfill-sent.mjs --since 2026-06-01

import { Entry } from "@napi-rs/keyring";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { archiveSent } from "../dist/archive.js";

const SERVICE = "proton-drafts-mcp";
const ACCOUNT = "bridge";

function loadCreds() {
  const raw = new Entry(SERVICE, ACCOUNT).getPassword();
  if (!raw) throw new Error("No creds in Credential Manager");
  return JSON.parse(raw);
}

async function findSentMailbox(client) {
  const list = await client.list();
  const sent = list.find(
    (m) => m.specialUse === "\\Sent" || /^sent$/i.test(m.name) || /^sent$/i.test(m.path)
  );
  if (!sent) throw new Error("Could not find Sent mailbox");
  return sent.path;
}

async function main() {
  const argv = process.argv.slice(2);
  let since;
  const toAddrs = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--since") {
      since = new Date(argv[++i]);
    } else {
      toAddrs.add(argv[i].toLowerCase());
    }
  }
  if (!since && toAddrs.size === 0) {
    console.error("Usage: node scripts/backfill-sent.mjs <to-address> [...] [--since YYYY-MM-DD]");
    process.exit(1);
  }

  const creds = loadCreds();
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
    const sentPath = await findSentMailbox(client);
    await client.mailboxOpen(sentPath, { readOnly: true });

    const criteria = since ? { since } : { all: true };
    const uids = await client.search(criteria, { uid: true });
    if (!uids || uids.length === 0) {
      console.log("No messages in Sent matching criteria.");
      return;
    }
    console.log(`Scanning ${uids.length} message(s) in ${sentPath}...`);

    let archived = 0;
    let skipped = 0;
    for await (const msg of client.fetch(uids, { uid: true, envelope: true, source: true }, { uid: true })) {
      const env = msg.envelope;
      const recipients = (env?.to ?? []).map((a) => (a.address ?? "").toLowerCase()).filter(Boolean);

      if (toAddrs.size > 0 && !recipients.some((r) => toAddrs.has(r))) {
        skipped++;
        continue;
      }

      const parsed = await simpleParser(msg.source);
      const fromAddr = parsed.from?.value?.[0]?.address ?? creds.user;
      const toList = (Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [])
        .flatMap((g) => g.value ?? [])
        .map((v) => v.address)
        .filter(Boolean);

      const messageId = (parsed.messageId ?? `uid-${msg.uid}`).toString();

      const { emlPath } = await archiveSent(msg.source, {
        uid: msg.uid,
        messageId,
        from: fromAddr,
        to: toList,
        subject: parsed.subject,
        sentAt: (parsed.date ?? msg.internalDate ?? new Date()).toISOString(),
      });
      console.log(`[ok] uid=${msg.uid} to=${toList.join(",")} subject=${(parsed.subject ?? "").slice(0, 50)} -> ${emlPath}`);
      archived++;
    }

    console.log(`\nBackfill complete: ${archived} archived, ${skipped} skipped.`);
  } finally {
    await client.logout().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
