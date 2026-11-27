import { json, packagePlugin, run, updateJSONVersion, type ReleaseConfig } from "@toolbelt/sdk/release";

/** The Toolbelt version packages are checked against: the minimum this plugin requires. */
const HOST_VERSION = "0.8.0";

export default {
	repo: "tkarakai/toolbelt-agent",
	hostVersion: HOST_VERSION,
	products: {
		plugin: {
			changelog: "CHANGELOG.md",
			version: () => json("toolbelt.json").version,
			async setVersion(v) {
				await updateJSONVersion("package.json", v);
				await updateJSONVersion("toolbelt.json", v);
				await updateVersionConstant(v);
			},
			async build() {
				await run(["bun", "scripts/build.ts"]);
				// Built on Linux, installed on Macs: refuse names that differ only by letter case.
				await run(["bun", "scripts/check-case.ts", "--git", "dist/package"]);
				return packagePlugin("dist/package", "artifacts", HOST_VERSION, []);
			},
		},
	},
} satisfies ReleaseConfig;

/** The version the ACP client reports to agents (`CLIENT` in src/session.ts). */
async function updateVersionConstant(v: string) {
	const file = "src/session.ts";
	const text = await Bun.file(file).text();
	await Bun.write(file, text.replace(/(export const CLIENT = \{[^}]*version: ")[^"]*(")/, `$1${v}$2`));
}
