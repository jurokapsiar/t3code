import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

class ServerUiBuildMissingError extends Schema.TaggedError<ServerUiBuildMissingError>()(
  "ServerUiBuildMissingError",
  { directory: Schema.String },
) {
  override get message(): string {
    return `Missing built UI at ${this.directory}/index.html. Run the server build first.`;
  }
}

export const stageServerUiAssets = Effect.fn("stageServerUiAssets")(function* (input: {
  readonly webDist: string;
  readonly factoryDist: string;
  readonly targetDir: string;
  readonly stripSourceMaps?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const clients = [
    { source: input.webDist, target: path.join(input.targetDir, "client") },
    { source: input.factoryDist, target: path.join(input.targetDir, "factory") },
  ];
  for (const { source } of clients) {
    if (!(yield* fs.exists(path.join(source, "index.html")))) {
      return yield* new ServerUiBuildMissingError({ directory: source });
    }
  }
  for (const { source, target } of clients) {
    yield* fs.copy(source, target);
    if (input.stripSourceMaps) {
      for (const entry of yield* fs.readDirectory(target, { recursive: true })) {
        if (entry.endsWith(".map")) yield* fs.remove(path.join(target, entry));
      }
    }
  }
});
