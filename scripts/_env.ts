import { config } from "dotenv";
import path from "node:path";

// Local CLI runs: .env.local (app secrets) and .env.toast (Toast MCP-style creds).
config({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
config({ path: path.resolve(process.cwd(), ".env.toast"), quiet: true });

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export const log = (msg: string, meta?: Record<string, unknown>) =>
  console.log(meta ? `${msg} ${JSON.stringify(meta)}` : msg);
