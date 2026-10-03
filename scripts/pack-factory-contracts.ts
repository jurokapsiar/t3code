// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

interface FactoryPackManifest {
  readonly name: string;
  readonly version: string;
  readonly type: "module";
  readonly files: readonly ["dist"];
  readonly exports: Readonly<Record<string, { readonly types: string; readonly import: string }>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

interface SourceManifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

const rootDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const factoryExports = {
  "./factory": { types: "./dist/factory.d.ts", import: "./dist/factory.js" },
  "./factoryRpc": { types: "./dist/factoryRpc.d.ts", import: "./dist/factoryRpc.js" },
  "./rpc": { types: "./dist/rpc.d.ts", import: "./dist/rpc.js" },
  "./environmentHttp": {
    types: "./dist/environmentHttp.d.ts",
    import: "./dist/environmentHttp.js",
  },
} as const;

export function makeFactoryPackManifest(
  versions: { readonly version: string; readonly effectVersion: string },
  sourceManifest: SourceManifest = { name: "@t3tools/contracts" },
): FactoryPackManifest {
  return {
    name: sourceManifest.name,
    version: versions.version,
    type: "module",
    files: ["dist"],
    exports: factoryExports,
    peerDependencies: { effect: versions.effectVersion },
  };
}

async function readEffectCatalogVersion(): Promise<string> {
  const workspaceConfig = await NodeFSP.readFile(
    NodePath.join(rootDir, "pnpm-workspace.yaml"),
    "utf8",
  );
  let inCatalog = false;
  for (const line of workspaceConfig.split(/\r?\n/)) {
    if (!inCatalog) {
      inCatalog = line === "catalog:";
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line) && !line.startsWith("#")) break;
    const match = /^  effect:\s*([^\s#]+)\s*(?:#.*)?$/.exec(line);
    if (match?.[1]) return match[1];
  }
  throw new Error("Could not find the Effect version in pnpm-workspace.yaml catalog");
}

async function findUnresolvedWorkspaceImport(directory: string): Promise<string | undefined> {
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    const entryPath = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      const unresolved = await findUnresolvedWorkspaceImport(entryPath);
      if (unresolved) return unresolved;
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts"))) {
      const content = await NodeFSP.readFile(entryPath, "utf8");
      if (/\b(?:from|import)\s*(?:\(\s*)?["'](?:@t3tools\/|workspace:|catalog:)/.test(content)) {
        return entryPath;
      }
    }
  }
  return undefined;
}

export async function packFactoryContracts(outputDirectory: string): Promise<string> {
  if (!NodePath.isAbsolute(outputDirectory)) {
    throw new Error("--output-dir must be an absolute path");
  }

  const outputDir = NodePath.resolve(outputDirectory);
  const sourceManifestPath = NodePath.join(rootDir, "packages/contracts/package.json");
  const sourceManifest = JSON.parse(await NodeFSP.readFile(sourceManifestPath, "utf8")) as {
    readonly name: string;
    readonly version: string;
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  if (sourceManifest.dependencies?.effect !== "catalog:") {
    throw new Error(
      'Expected packages/contracts to keep its workspace "effect: catalog:" dependency',
    );
  }

  const stageDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-factory-contracts-"));
  try {
    const distDir = NodePath.join(stageDir, "dist");
    await NodeFSP.mkdir(distDir, { recursive: true });
    await NodeFSP.mkdir(outputDir, { recursive: true });

    NodeChildProcess.execFileSync(
      process.execPath,
      [
        NodePath.join(rootDir, "node_modules/typescript/bin/tsc"),
        "--project",
        NodePath.join(rootDir, "packages/contracts/tsconfig.factory-dist.json"),
        "--outDir",
        distDir,
      ],
      { cwd: rootDir, stdio: "inherit" },
    );

    const unresolvedImport = await findUnresolvedWorkspaceImport(distDir);
    if (unresolvedImport) {
      throw new Error(`Built contract output has a workspace import: ${unresolvedImport}`);
    }

    const manifest = makeFactoryPackManifest(
      {
        version: sourceManifest.version,
        effectVersion: await readEffectCatalogVersion(),
      },
      sourceManifest,
    );
    await NodeFSP.writeFile(
      NodePath.join(stageDir, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const packed = NodeChildProcess.execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", outputDir, stageDir],
      { cwd: stageDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    const [packResult] = JSON.parse(packed) as ReadonlyArray<{ readonly filename: string }>;
    if (!packResult) throw new Error("npm pack did not report a tarball filename");
    const tarballPath = NodePath.join(outputDir, packResult.filename);
    process.stdout.write(`Packed factory contracts: ${tarballPath}\n`);
    return tarballPath;
  } finally {
    await NodeFSP.rm(stageDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [flag, outputDirectory, ...extraArgs] = process.argv.slice(2);
  if (flag !== "--output-dir" || !outputDirectory || extraArgs.length > 0) {
    throw new Error(
      "Usage: node scripts/pack-factory-contracts.ts --output-dir <absolute-directory>",
    );
  }
  await packFactoryContracts(outputDirectory);
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  await main();
}
