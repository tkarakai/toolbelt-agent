// Bundles the plugin into dist/package, the archive root.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const out = "dist/package";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const result = await Bun.build({ entrypoints: ["src/index.ts"], target: "bun" });
if (!result.success) throw new AggregateError(result.logs, "Building src/index.ts failed");
await Bun.write(`${out}/index.js`, result.outputs[0]!);
writeFileSync(`${out}/toolbelt.json`, readFileSync("toolbelt.json"));
writeFileSync(`${out}/NOTICE`, "Toolbelt Agent by Tamas Karakai. The public Toolbelt SDK is bundled. Agents are installed separately by the person.\n");
