import { Entry } from "@napi-rs/keyring";

const SERVICE = "proton-drafts-mcp";
const ACCOUNT = "bridge";

export interface BridgeCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
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
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: BridgeCredentials): void {
  const entry = new Entry(SERVICE, ACCOUNT);
  entry.setPassword(JSON.stringify(creds));
}

export function deleteCredentials(): boolean {
  const entry = new Entry(SERVICE, ACCOUNT);
  return entry.deletePassword();
}
