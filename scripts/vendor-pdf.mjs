/**
 * Copies the four pdf.js files LivePage needs out of node_modules and into
 * extension/vendor/pdfjs, which is committed.
 *
 * The extension has no install step — you load it unpacked and it runs — and
 * that is worth keeping. So the vendored copies live in git the same way
 * content/livepage.iife.js does, and this script exists to regenerate them
 * rather than to be part of building.
 *
 *   npm i -D pdfjs-dist@<version> && npm run vendor:pdf
 */
import { cp, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "pdfjs-dist");
const to = join(root, "extension", "vendor", "pdfjs");

// The minified builds, because these are committed and read by nobody.
// pdf_viewer is the "components" build: EventBus, PDFViewer, PDFLinkService
// and a real per-page text layer, without the default viewer's toolbar, l10n
// and preferences — none of which we want.
const FILES = [
  ["build/pdf.min.mjs", "pdf.mjs"],
  ["build/pdf.worker.min.mjs", "pdf.worker.mjs"],
  ["web/pdf_viewer.mjs", "pdf_viewer.mjs"],
  ["web/pdf_viewer.css", "pdf_viewer.css"]
];

await mkdir(to, { recursive: true });

for (const [source, target] of FILES) {
  const body = await readFile(join(from, source), "utf8");
  // The maps are not shipped, and Chrome logs a failed fetch for every one.
  await writeFile(join(to, target), body.replace(/\n*\/\/# sourceMappingURL=.*$/m, "\n"));
}

// pdf_viewer.css names these by relative path. They are 112K and copying
// them is cheaper than auditing which rules we can never reach.
await cp(join(from, "web", "images"), join(to, "images"), { recursive: true });

// The character maps and the base-14 fonts. 2.5MB, and worth every byte: a
// paper that embeds neither extracts as mojibake without them, and a product
// whose whole point is quoting the text cannot ship that.
await cp(join(from, "cmaps"), join(to, "cmaps"), { recursive: true });
await cp(join(from, "standard_fonts"), join(to, "standard_fonts"), { recursive: true });

await copyFile(join(from, "LICENSE"), join(to, "LICENSE"));

const { version } = JSON.parse(await readFile(join(from, "package.json"), "utf8"));
await writeFile(
  join(to, "VERSION"),
  `pdfjs-dist ${version}\nRegenerate with: npm i -D pdfjs-dist@${version} && npm run vendor:pdf\n`
);

console.log(`Vendored pdfjs-dist ${version} into extension/vendor/pdfjs`);
