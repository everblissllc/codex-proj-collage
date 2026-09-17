import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "deal-card-tests-"));
execFileSync("./node_modules/.bin/tsc", ["-p", "tsconfig.runtime-test.json", "--outDir", out], { stdio: "inherit" });
writeFileSync(join(out, "package.json"), '{"type":"commonjs"}');
const result = spawnSync(process.execPath, ["--test", "test/product.node.test.cjs", "test/cache.node.test.cjs", "test/elf.node.test.cjs", "test/amazon.node.test.cjs"], {
  stdio: "inherit",
  env: { ...process.env, COMPILED_ROOT: out }
});
if ((result.status ?? 1) !== 0) {
  process.exitCode = result.status ?? 1;
} else {
  const pilotOut = mkdtempSync(join(tmpdir(), "amazon-creators-pilot-tests-"));
  execFileSync("./node_modules/.bin/tsc", ["-p", "tsconfig.amazon-creators-pilot.json", "--noEmit", "false", "--outDir", pilotOut], { stdio: "inherit" });
  writeFileSync(join(pilotOut, "package.json"), '{"type":"module"}');
  const pilotResult = spawnSync(process.execPath, ["--test", join(pilotOut, "test/amazon-creators-direct-runner.node.test.js")], { stdio: "inherit" });
  process.exitCode = pilotResult.status ?? 1;
}
