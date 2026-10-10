import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";
import { build } from "vite-plus";
import * as NodeAssert from "node:assert/strict";
import { forbiddenProductionModuleIds } from "../src/factory/releaseChecks";

async function checkInitialBundle() {
  const graph: Array<{
    file: string;
    isEntry: boolean;
    imports: string[];
    dynamicImports: string[];
    modules: Array<{ id: string; renderedLength: number }>;
  }> = [];
  const result = await build({
    build: { write: false, manifest: true },
    plugins: [
      {
        name: "initial-module-evidence",
        generateBundle(_options, bundle) {
          for (const output of Object.values(bundle)) {
            if (output.type === "chunk")
              graph.push({
                file: output.fileName,
                isEntry: output.isEntry,
                imports: output.imports,
                dynamicImports: output.dynamicImports,
                modules: Object.entries(output.modules).map(([id, info]) => ({
                  id,
                  renderedLength: info.renderedLength,
                })),
              });
          }
        },
      },
    ],
  });
  if ("on" in result) throw new Error("A production bundle cannot be a watcher.");
  const outputs = Array.isArray(result) ? result.flatMap((output) => output.output) : result.output;
  const assets = new Map(
    outputs.map((output) => [
      output.fileName,
      output.type === "chunk" ? output.code : output.source,
    ]),
  );
  const html = assets.get("index.html");
  if (typeof html !== "string") throw new Error("Missing production HTML.");
  const initial = new Set(["index.html"]);
  for (const match of html.matchAll(/(?:src|href)="\/factory\/([^"?#]+)"/g)) {
    if (/\.(?:js|css)$/.test(match[1])) initial.add(match[1]);
  }
  for (const entry of graph.filter((chunk) => chunk.isEntry)) initial.add(entry.file);
  for (const file of initial) {
    for (const dependency of graph.find((chunk) => chunk.file === file)?.imports ?? [])
      initial.add(dependency);
  }
  const files = [...initial].map((file) => {
    const content = assets.get(file);
    if (content === undefined) throw new Error(`Missing initial asset: ${file}`);
    const bytes = Buffer.from(content);
    return {
      file,
      rawBytes: bytes.length,
      gzipBytes: NodeZlib.gzipSync(bytes).length,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const forbidden = graph
    .filter((chunk) => initial.has(chunk.file))
    .flatMap((chunk) =>
      chunk.modules
        .filter((module) => /\/unstable\/httpapi\//.test(module.id))
        .map((module) => ({ chunk: chunk.file, ...module })),
    );
  const chunks = graph.map((chunk) => {
    const content = assets.get(chunk.file);
    if (content === undefined) throw new Error(`Missing emitted chunk: ${chunk.file}`);
    return {
      file: chunk.file,
      rawBytes: Buffer.byteLength(content),
      gzipBytes: NodeZlib.gzipSync(content).length,
    };
  });
  const forbiddenFixtures = forbiddenProductionModuleIds(graph.flatMap((chunk) => chunk.modules));
  const lazyHttp = graph.filter(
    (chunk) =>
      !initial.has(chunk.file) &&
      chunk.modules.some((module) => /\/unstable\/httpapi\//.test(module.id)),
  );
  const total = files.reduce((sum, file) => sum + file.gzipBytes, 0);
  const evidence = {
    gzipRuntime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
    files,
    baselineBytes: 177782,
    totalBytes: total,
    growthBytes: total - 177782,
    limitBytes: 153600,
    forbidden,
    forbiddenFixtures,
    lazyHttp: lazyHttp.map((chunk) => chunk.file),
    chunks,
    graph,
  };
  if (process.env.U6A_BUNDLE_EVIDENCE)
    NodeFS.writeFileSync(process.env.U6A_BUNDLE_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
  NodeAssert.ok(graph.length > 0, "The bundler must report its module graph.");
  NodeAssert.ok(
    files.some((file) => file.file.endsWith(".css")),
    "Include initial CSS.",
  );
  NodeAssert.ok(lazyHttp.length > 0, "Detail HTTP must remain available lazily.");
  NodeAssert.deepEqual(
    forbiddenFixtures,
    [],
    "No application fixtures, mocks or test helpers may ship in any chunk.",
  );
  NodeAssert.deepEqual(forbidden, [], "No HTTP API modules may execute initially.");
  NodeAssert.ok(total - 177782 <= 153600, "Initial gzip growth exceeds 150 KiB.");
  console.log(
    JSON.stringify({
      totalBytes: total,
      growthBytes: total - 177782,
      forbidden,
      forbiddenFixtures,
    }),
  );
}

await checkInitialBundle();
