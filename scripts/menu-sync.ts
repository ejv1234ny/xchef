/** pnpm menu:sync [--force] — pull Menus v2 into menu_items (modifier options as their own rows). */
import "./_env";
import { hasFlag, log } from "./_env";
import { runMenuSync } from "@/lib/jobs/menuSync";

runMenuSync({ force: hasFlag("force"), log })
  .then((results) => {
    if (!results.length) console.log("No locations with Toast credentials. Run `pnpm creds` first.");
    console.table(results);
    if (results.some((r) => r.error)) process.exit(1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
