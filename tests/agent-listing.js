// agent-class.md's code listing IS skills/sparkbtcbot/scripts/spark-agent.js,
// up to the end of the class, with three mechanical changes so it reads as a
// standalone file: the dotenv import becomes a comment, the demo's
// pathToFileURL import goes, and ../../../lib/ paths become ./lib/. Hand-syncing
// it drifted (missing helpers and fixes, about 200 stale lines), so it is
// generated: `npm run sync:agent-listing`. The parity test fails when the two
// differ.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const SRC_PATH = fileURLToPath(new URL("../skills/sparkbtcbot/scripts/spark-agent.js", import.meta.url));
export const MD_PATH = fileURLToPath(new URL("../skills/sparkbtcbot/references/agent-class.md", import.meta.url));
const FENCE = "```javascript\n";

export function listingFromSource(src) {
  const end = src.indexOf("\n// --- Demo ---");
  if (end < 0) throw new Error("spark-agent.js: no `// --- Demo ---` marker after the class");
  return src
    .slice(0, end)
    .replace(/\n+$/, "\n")
    .replace(/^import "dotenv\/config";\n/, '// (the runnable scripts/spark-agent.js also does `import "dotenv/config"` here)\n')
    .replace(/^import \{ pathToFileURL \} from "node:url";\n/m, "")
    .replaceAll('"../../../lib/', '"./lib/');
}

// [start, end) of the listing inside agent-class.md (the first javascript block).
export function listingBounds(md) {
  const start = md.indexOf(FENCE);
  if (start < 0) throw new Error("agent-class.md: no ```javascript block");
  const end = md.indexOf("\n```", start + FENCE.length);
  return [start + FENCE.length, end + 1];
}

export async function syncListing() {
  const [src, md] = await Promise.all([readFile(SRC_PATH, "utf8"), readFile(MD_PATH, "utf8")]);
  const [a, b] = listingBounds(md);
  const next = md.slice(0, a) + listingFromSource(src) + md.slice(b);
  if (next !== md) await writeFile(MD_PATH, next);
  return next !== md;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log((await syncListing()) ? "agent-class.md listing updated" : "agent-class.md listing already in sync");
}
