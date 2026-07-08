// Bundles the *.test.ts files to plain JS so Node's built-in test runner
// (node --test) can execute them without a TypeScript runtime dependency.
const esbuild = require("esbuild");

async function main() {
  await esbuild.build({
    entryPoints: ["src/**/*.test.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outdir: "dist-test",
    // vscode is only available inside the extension host; tests never touch it.
    external: ["vscode"],
    logLevel: "info",
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
