// The code listing in references/agent-class.md is scripts/spark-agent.js with
// two edits, so a reader can drop it into a project that has lib/ next to it:
//   - lib imports point at ./lib/ instead of ../../../lib/,
//   - the runnable demo at the bottom (from "// --- Demo ---") is cut, along
//     with the pathToFileURL import only the demo uses.
// agent-class-parity.test.js fails when the doc drifts from this. To rewrite
// the doc's listing from the script:
//   node tests/helpers/agent-class-listing.js --write
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const SCRIPT_PATH = join(ROOT, "skills/sparkbtcbot/scripts/spark-agent.js");
export const DOC_PATH = join(ROOT, "skills/sparkbtcbot/references/agent-class.md");

const URL_IMPORT = 'import { pathToFileURL } from "node:url";\n';
const DEMO = "\n// --- Demo ---\n";

export function listingFromScript(script) {
  for (const marker of [URL_IMPORT, DEMO]) {
    if (!script.includes(marker)) throw new Error(`spark-agent.js no longer contains ${JSON.stringify(marker.trim())}; update tests/helpers/agent-class-listing.js`);
  }
  return script
    .slice(0, script.indexOf(DEMO))
    .replace(URL_IMPORT, "")
    .replaceAll('"../../../lib/', '"./lib/')
    .replace(/\s+$/, "\n");
}

// The listing is the first ```javascript block in the doc.
export function docListing(md) {
  const open = "```javascript\n";
  const start = md.indexOf(open);
  const end = md.indexOf("\n```\n", start);
  if (start < 0 || end < 0) throw new Error("agent-class.md: no ```javascript listing found");
  return { start: start + open.length, end: end + 1, text: md.slice(start + open.length, end + 1) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "--write") {
    console.error("usage: node tests/helpers/agent-class-listing.js --write");
    process.exit(2);
  }
  const [script, md] = await Promise.all([readFile(SCRIPT_PATH, "utf8"), readFile(DOC_PATH, "utf8")]);
  const { start, end } = docListing(md);
  await writeFile(DOC_PATH, md.slice(0, start) + listingFromScript(script) + md.slice(end));
  console.log("agent-class.md listing rewritten from scripts/spark-agent.js");
}
