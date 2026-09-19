import "dotenv/config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the Lightning dedup store (lib/transfer-ids.js): SparkAgent creates
// it from env at construction, so without this every test that pays through
// the wrapper would write real entries under ~/.spark/ln-dedup. Tests that
// need their own store set SPARK_LN_DEDUP_PATH themselves before constructing.
process.env.SPARK_LN_DEDUP_PATH = mkdtempSync(join(tmpdir(), "ln-dedup-test-"));

// Same for the audit log (lib/audit-log.js): SparkAgent appends a line for
// every policy denial and live money-moving outcome, so an unisolated suite
// would fill the developer's real ~/.spark/audit.jsonl with mock spends.
process.env.SPARK_AUDIT_LOG_PATH = join(mkdtempSync(join(tmpdir(), "audit-test-")), "audit.jsonl");
