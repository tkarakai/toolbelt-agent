// Bundles the plugin into dist/package, the archive root.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const out = "dist/package";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const version = JSON.parse(readFileSync("toolbelt.json", "utf8")).version;
const result = await Bun.build({ entrypoints: ["src/index.ts"], target: "bun" });
if (!result.success) throw new AggregateError(result.logs, "Building src/index.ts failed");
await Bun.write(`${out}/index.js`, result.outputs[0]!);
// The Model API agent: its own process, started by the plugin like any ACP agent.
const agent = await Bun.build({ entrypoints: ["src/model-api/main.ts"], target: "bun", minify: true, define: { MODEL_API_VERSION: JSON.stringify(version) } });
if (!agent.success) throw new AggregateError(agent.logs, "Building src/model-api/main.ts failed");
if (agent.outputs.length !== 1) throw new Error(`The Model API agent should build to one file, not ${agent.outputs.length}`);
await Bun.write(`${out}/model-api.js`, agent.outputs[0]!);
writeFileSync(`${out}/toolbelt.json`, readFileSync("toolbelt.json"));
writeFileSync(`${out}/NOTICE`, "Toolbelt Agent by Tamas Karakai. The public Toolbelt SDK is bundled. The Model API agent (model-api.js) bundles @earendil-works/pi-ai, pi-durable, chord and their dependencies (MIT; see each package's license). Other agents are installed separately by the person.\n");
