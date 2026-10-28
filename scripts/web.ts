import { spawn, spawnSync } from "node:child_process";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import * as esbuild from "esbuild";
import { cmlIndexSource } from "./cmlIndexSource";

/**
 * Builds the console into `packages/tg-web/www/`, the directory Firebase
 * Hosting serves.
 *
 *   npm run build        # one production build
 *   npm run dev          # watch, and serve on http://localhost:8080
 *
 * Three steps: regenerate the CML index, compile Tailwind, bundle with
 * esbuild. The bundle reads the real `arrmatura-web` source — `tsconfigRaw`
 * keeps esbuild from following the root tsconfig's `paths`, which point the
 * type-checker at a declaration file (`src/types/arrmatura-web.d.ts`).
 */

const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "packages/tg-web");
const WWW = join(WEB, "www");
const DIST = join(WWW, "dist");
const INDEX = join(WEB, "src/index.cml.ts");

/** The dev origin; the api function allows any localhost origin in the emulator. */
const DEV_PORT = 8080;

const serve = process.argv.includes("--serve");

function templates(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return templates(path);
    return entry.endsWith(".xml") ? [path] : [];
  });
}

function writeCmlIndex(): void {
  const files = templates(join(WEB, "cml")).map((file) =>
    relative(posix.dirname(INDEX), file).split("\\").join("/"),
  );
  writeFileSync(INDEX, cmlIndexSource(files));
  console.log(`cml      ${files.length} templates → ${relative(process.cwd(), INDEX)}`);
}

const tailwind = (watch: boolean): string[] => [
  "@tailwindcss/cli",
  "-i",
  join(WEB, "index.css"),
  "-o",
  join(DIST, "index.css"),
  // `--watch` alone stops when stdin closes, as it does under a detached
  // `npm run dev`; the CSS then silently stops following the templates.
  ...(watch ? ["--watch=always"] : ["--minify"]),
];

const options: esbuild.BuildOptions = {
  entryPoints: [join(WEB, "src/index.ts")],
  outdir: DIST,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: !serve,
  // Arrmatura registers a service class under its constructor's name, so
  // minification must not rename one.
  keepNames: true,
  sourcemap: serve ? "linked" : "external",
  loader: { ".xml": "text" },
  // `zod` is a peer of the linked `arrmatura-vibe`, which resolves its own
  // installed copy otherwise: a second ~450 KB zod in the bundle.
  alias: { zod: join(ROOT, "node_modules/zod") },
  tsconfigRaw: "{}",
  logLevel: "info",
  // Dev only: esbuild's change stream reloads the page on every rebuild.
  ...(serve
    ? {
        banner: {
          js: 'new EventSource("/esbuild").addEventListener("change", () => location.reload());',
        },
      }
    : {}),
};

writeCmlIndex();

if (serve) {
  spawn("npx", tailwind(true), { stdio: "inherit" });
  const context = await esbuild.context(options);
  await context.watch();
  await context.serve({ servedir: WWW, port: DEV_PORT, fallback: join(WWW, "index.html") });
  console.log(`serving  http://localhost:${DEV_PORT}`);
} else {
  const css = spawnSync("npx", tailwind(false), { stdio: "inherit" });
  if (css.status !== 0) process.exit(css.status ?? 1);
  await esbuild.build(options);
}
