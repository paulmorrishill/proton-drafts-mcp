import { Entry } from "@napi-rs/keyring";

const SERVICE = "proton-drafts-mcp";
const ACCOUNT = "bridge";

export interface BridgeCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
  smtpPort?: number;
  smtpSecure?: boolean;
  allowedReadAddresses?: string[];
}

export function loadCredentials(): BridgeCredentials | null {
  const entry = new Entry(SERVICE, ACCOUNT);
  const raw = entry.getPassword();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.host === "string" &&
      typeof parsed.port === "number" &&
      typeof parsed.user === "string" &&
      typeof parsed.password === "string" &&
      typeof parsed.secure === "boolean"
    ) {
      const creds: BridgeCredentials = {
        host: parsed.host,
        port: parsed.port,
        user: parsed.user,
        password: parsed.password,
        secure: parsed.secure,
      };
      if (typeof parsed.smtpPort === "number") creds.smtpPort = parsed.smtpPort;
      if (typeof parsed.smtpSecure === "boolean") creds.smtpSecure = parsed.smtpSecure;
      if (Array.isArray(parsed.allowedReadAddresses)) {
        creds.allowedReadAddresses = parsed.allowedReadAddresses
          .filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
          .map((s: string) => s.trim());
      }
      return creds;
    }
    return null;
  } catch {
    return null;
  }
}

export function isReadAllowed(creds: BridgeCredentials, address: string): boolean {
  if (!creds.allowedReadAddresses || creds.allowedReadAddresses.length === 0) return true;
  const t = address.toLowerCase();
  return creds.allowedReadAddresses.some((a) => a.toLowerCase() === t);
}

export function anyReadAllowed(creds: BridgeCredentials, addresses: string[]): boolean {
  if (!creds.allowedReadAddresses || creds.allowedReadAddresses.length === 0) return true;
  return addresses.some((a) => isReadAllowed(creds, a));
}

export function saveCredentials(creds: BridgeCredentials): void {
  const entry = new Entry(SERVICE, ACCOUNT);
  entry.setPassword(JSON.stringify(creds));
}

export function deleteCredentials(): boolean {
  const entry = new Entry(SERVICE, ACCOUNT);
  return entry.deletePassword();
}
