import { productionGateInput, runProductionClient } from "./productionClient";

const input = process.env.T3_FACTORY_GATE_INPUT;
if (input === undefined)
  throw new Error("The source gate must supply isolated production listeners and cookie grants.");
await runProductionClient(productionGateInput(input));
console.info("UI_PRODUCTION_GATE passed");
