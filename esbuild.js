const esbuild = require("esbuild");
const fs = require("node:fs/promises");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const icons = path.dirname(require.resolve("@vscode/codicons/dist/codicon.css"));
  await fs.mkdir("dist/icons", { recursive: true });
  await fs.mkdir("dist/licenses", { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(icons, "codicon.css"), "dist/icons/codicon.css"),
    fs.copyFile(path.join(icons, "codicon.ttf"), "dist/icons/codicon.ttf"),
    fs.copyFile(path.join(icons, "..", "LICENSE"), "dist/licenses/codicons.txt"),
    fs.copyFile(path.join(icons, "..", "LICENSE-CODE"), "dist/licenses/codicons-code.txt"),
    fs.copyFile("node_modules/jsonc-parser/LICENSE.md", "dist/licenses/jsonc-parser.txt"),
  ]);
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    mainFields: ["module", "main"],
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "info",
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
