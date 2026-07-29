const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");
const distDir = path.join(__dirname, "dist");
fs.mkdirSync(distDir, { recursive: true });

async function buildOnce() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, "src/code.ts")],
    bundle: true,
    outfile: path.join(distDir, "code.js"),
    target: "es2017",
    format: "iife",
    platform: "browser",
    logLevel: "info",
  });

  await esbuild.build({
    entryPoints: [path.join(__dirname, "src/ui.ts")],
    bundle: true,
    outfile: path.join(distDir, "ui.js"),
    target: "es2017",
    format: "iife",
    platform: "browser",
    logLevel: "info",
  });

  const template = fs.readFileSync(path.join(__dirname, "src/ui.template.html"), "utf8");
  const uiJs = fs.readFileSync(path.join(distDir, "ui.js"), "utf8");
  const html = template.replace("/*__UI_SCRIPT__*/", uiJs);
  fs.writeFileSync(path.join(distDir, "ui.html"), html);
  console.log("Wrote dist/ui.html");
}

async function main() {
  if (watch) {
    const rebuild = async () => {
      try {
        await buildOnce();
      } catch (err) {
        console.error(err);
      }
    };
    await rebuild();
    fs.watch(path.join(__dirname, "src"), { recursive: true }, () => {
      rebuild();
    });
    console.log("Watching src/ for changes...");
  } else {
    await buildOnce();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
