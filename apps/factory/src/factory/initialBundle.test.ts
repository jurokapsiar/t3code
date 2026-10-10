import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

const BundleEvidence = Schema.Struct({
  gzipRuntime: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      file: Schema.String,
      rawBytes: Schema.Number,
      gzipBytes: Schema.Number,
      sha256: Schema.String,
    }),
  ),
  baselineBytes: Schema.Number,
  totalBytes: Schema.Number,
  growthBytes: Schema.Number,
  limitBytes: Schema.Number,
  forbidden: Schema.Array(Schema.Unknown),
  forbiddenFixtures: Schema.Array(Schema.String),
  lazyHttp: Schema.Array(Schema.String),
});
const decodeBundleEvidence = Schema.decodeUnknownSync(BundleEvidence);

it("writes and checks the measured initial bundle evidence", () => {
  const directory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "t3factory-bundle-evidence-"),
  );
  const evidencePath = NodePath.join(directory, "initial-bundle.json");
  try {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/check-initial-bundle.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "production", U6A_BUNDLE_EVIDENCE: evidencePath },
      },
    );
    if (result.error) throw result.error;
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const evidence = decodeBundleEvidence(JSON.parse(NodeFS.readFileSync(evidencePath, "utf8")));
    expect(evidence.gzipRuntime).toContain("Node ");
    expect(evidence.baselineBytes).toBe(177_782);
    expect(evidence.limitBytes).toBe(153_600);
    expect(evidence.growthBytes).toBe(evidence.totalBytes - evidence.baselineBytes);
    expect(evidence.growthBytes).toBeLessThanOrEqual(evidence.limitBytes);
    expect(evidence.files.some((file) => file.file === "index.html")).toBe(true);
    expect(evidence.files.some((file) => file.file.endsWith(".css"))).toBe(true);
    expect(evidence.files.some((file) => file.file.endsWith(".js"))).toBe(true);
    expect(evidence.forbidden).toEqual([]);
    expect(evidence.forbiddenFixtures).toEqual([]);
    expect(evidence.lazyHttp.length).toBeGreaterThan(0);
  } finally {
    NodeFS.rmSync(evidencePath, { force: true });
    NodeFS.rmdirSync(directory);
  }
}, 30_000);
