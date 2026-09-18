import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "deal-card-tests-"));
execFileSync("./node_modules/.bin/tsc", ["-p", "tsconfig.runtime-test.json", "--outDir", out], { stdio: "inherit" });
writeFileSync(join(out, "package.json"), '{"type":"commonjs"}');
const result = spawnSync(process.execPath, ["--test", "test/product.node.test.cjs", "test/cache.node.test.cjs", "test/elf.node.test.cjs", "test/amazon.node.test.cjs", "test/sovrn.node.test.cjs"], {
  stdio: "inherit",
  env: { ...process.env, COMPILED_ROOT: out }
});
process.exitCode = result.status ?? 1;
