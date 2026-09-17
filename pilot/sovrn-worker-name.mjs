const runId = process.argv[2] ?? "";
const runAttempt = process.argv[3] ?? "";
if (!/^\d+$/.test(runId) || !/^\d+$/.test(runAttempt)) {
  console.error("Invalid GitHub run identity for temporary Sovrn Worker.");
  process.exit(2);
}
const name = `affiliate-deal-card-sovrn-${runId}-${runAttempt}`;
if (name.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
  console.error("Generated temporary Sovrn Worker name is invalid.");
  process.exit(2);
}
console.log(name);
