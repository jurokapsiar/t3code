import { startFactoryFrameMessageCapture } from "./factoryFrameCapture";
import { showBootError } from "./lib/bootError";

startFactoryFrameMessageCapture();

// Bundled dev can move UI code into shared chunks. Load it only after this
// entry runs the React refresh preamble, and catch failures before React mounts.
void import("./main").then(({ startup }) => startup).catch(showBootError);
