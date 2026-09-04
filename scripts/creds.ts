/**
 * pnpm creds — store Toast credentials into Supabase Vault for the location.
 * Reads TOAST_CLIENT_ID / TOAST_CLIENT_SECRET / TOAST_RESTAURANT_GUIDS from
 * .env.toast (or the environment); prompts for anything missing.
 */
import "./_env";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createServiceSupabase } from "@/lib/db/service";

async function ask(rl: readline.Interface, label: string, current?: string, secret = false): Promise<string> {
  if (current) return current;
  if (secret) {
    stdout.write(`${label}: `);
    return new Promise((resolve) => {
      let buf = "";
      const onData = (ch: Buffer) => {
        const c = ch.toString();
        if (c === "\n" || c === "\r") {
          stdin.setRawMode?.(false);
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(buf);
        } else if (c === "") process.exit(1);
        else buf += c;
      };
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.on("data", onData);
    });
  }
  return (await rl.question(`${label}: `)).trim();
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const clientId = await ask(rl, "TOAST_CLIENT_ID", process.env.TOAST_CLIENT_ID);
  const guid = await ask(rl, "Toast location GUID", process.env.TOAST_RESTAURANT_GUIDS?.split(",")[0]?.trim());
  const secret = await ask(rl, "TOAST_CLIENT_SECRET", process.env.TOAST_CLIENT_SECRET, true);
  rl.close();
  if (!clientId || !guid || !secret) throw new Error("All three values are required");

  const svc = createServiceSupabase();
  let { data: locations } = await svc.from("locations").select("*").order("created_at").limit(1);
  if (!locations?.length) {
    const { data: t, error } = await svc.from("tenants").insert({ name: "Mad Moose" }).select("id").single();
    if (error) throw error;
    const { error: lerr } = await svc.from("locations").insert({
      tenant_id: t.id,
      name: "Mad Moose Bar & Grill",
      timezone: "America/New_York",
      inbound_email_slug: "madmoose",
    });
    if (lerr) throw lerr;
    ({ data: locations } = await svc.from("locations").select("*").order("created_at").limit(1));
  }
  const location = locations![0];
  const { error: uerr } = await svc.from("locations").update({ toast_location_guid: guid }).eq("id", location.id);
  if (uerr) throw uerr;
  const { error } = await svc.rpc("set_toast_credentials", {
    p_location_id: location.id,
    p_client_id: clientId,
    p_client_secret: secret,
  });
  if (error) throw error;
  console.log(`Stored Toast credentials in Vault for location "${location.name}" (${location.id}).`);
  console.log("Next: pnpm sync");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
