import * as Schema from "effect/Schema";
import {
  FactoryFrameErrorCode,
  FactoryFrameInitMessage,
  FactoryFrameTarget,
} from "@t3tools/contracts";
import {
  parseFactoryEmbedRoute,
  resolveFactoryEmbedHandshakeMessage,
  validateFactoryFrameInit,
  waitForFactoryFrameInit,
} from "../../../../web/src/factoryEmbed.ts";

const input = JSON.parse(await readInput());
const route = parseFactoryEmbedRoute(new URL(input.href, input.origin).href);
if (route === null) throw new Error("Native Factory embed route was rejected");
const init = Schema.decodeUnknownSync(FactoryFrameInitMessage)(input.init);
const expectedTarget = Schema.decodeUnknownSync(FactoryFrameTarget)(input.expectedTarget);
if (!sameTarget(route.target, expectedTarget)) throw new Error("Route and source target differ");
if (!sameTarget(init.target, expectedTarget))
  throw new Error("Parent init and source target differ");

const parent = {};
const mismatchedTarget = {
  ...expectedTarget,
  registrationId: `${expectedTarget.registrationId}-other`,
};
for (const [data, origin, source] of [
  [init, "https://invalid.example", parent],
  [init, input.origin, {}],
  [{ ...init, version: 2 }, input.origin, parent],
  [{ ...init, target: mismatchedTarget }, input.origin, parent],
]) {
  if (
    validateFactoryFrameInit({
      data,
      origin,
      source,
      parent,
      expectedOrigin: input.origin,
      routeTarget: route.target,
    }) !== null
  )
    throw new Error("Invalid parent init was accepted");
}

const expectInitFailure = async (data, origin, code) => {
  const boundary = makeFrameBoundary(input.origin);
  const pending = waitForFactoryFrameInit(route.target, boundary.host, 10_000);
  boundary.send(data, origin);
  const error = await pending.then(
    () => {
      throw new Error(`Expected init rejection: ${code}`);
    },
    (failure) => failure,
  );
  if (error.code !== code) throw new Error(`Expected ${code}; received ${error.code}`);
};
await expectInitFailure(init, "https://invalid.example", "invalid-parent");
await expectInitFailure({ ...init, version: 2 }, input.origin, "invalid-message");
await expectInitFailure({ ...init, target: mismatchedTarget }, input.origin, "target-mismatch");

const boundary = makeFrameBoundary(input.origin);
const pending = waitForFactoryFrameInit(route.target, boundary.host, 10_000);
boundary.send(init, input.origin, {});
boundary.send(init);
const accepted = await pending;
if (!sameTarget(accepted.target, expectedTarget))
  throw new Error("Accepted init changed its target");

const activeTarget =
  input.activeTarget === null
    ? null
    : Schema.decodeUnknownSync(FactoryFrameTarget)(input.activeTarget);
const connectionPhase = Schema.decodeUnknownSync(
  Schema.Literals(["connecting", "connected", "disconnected", "blocked"]),
)(input.connectionPhase);
const threadState = Schema.decodeUnknownSync(Schema.Literals(["pending", "ready", "missing"]))(
  input.threadState,
);
const failureCode =
  input.failureCode === undefined
    ? undefined
    : Schema.decodeUnknownSync(FactoryFrameErrorCode)(input.failureCode);
const message = resolveFactoryEmbedHandshakeMessage({
  expectedTarget,
  activeTarget,
  routeTarget: input.routeTarget,
  connectionPhase,
  threadState,
  ...(failureCode === undefined ? {} : { failureCode }),
  alreadyReady: true,
});
process.stdout.write(JSON.stringify({ target: route.target, message }));

function sameTarget(left, right) {
  return (
    left.registrationId === right.registrationId &&
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId
  );
}

function makeFrameBoundary(origin) {
  const events = new EventTarget();
  const parent = {};
  const host = {
    parent,
    location: { origin },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
  return {
    host,
    send(data, eventOrigin = origin, source = parent) {
      events.dispatchEvent(
        Object.assign(new Event("message"), { data, origin: eventOrigin, source }),
      );
    },
  };
}

async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}
