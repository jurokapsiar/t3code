const INITIAL_BUNDLE_GROWTH_BUDGET_BYTES = 150 * 1024;

export type InitialBundleBudgetResult =
  | { readonly ok: true; readonly growthBytes: number }
  | {
      readonly ok: false;
      readonly reason: "initial-bundle-too-large";
      readonly growthBytes: number;
    };

export function checkInitialBundleBudget(input: {
  readonly baselineGzipBytes: number;
  readonly currentGzipBytes: number;
}): InitialBundleBudgetResult {
  const growthBytes = input.currentGzipBytes - input.baselineGzipBytes;
  return growthBytes <= INITIAL_BUNDLE_GROWTH_BUDGET_BYTES
    ? { ok: true, growthBytes }
    : { ok: false, reason: "initial-bundle-too-large", growthBytes };
}

export function forbiddenProductionModuleIds(
  modules: readonly { readonly id: string; readonly renderedLength: number }[],
): string[] {
  return modules
    .filter(
      (module) =>
        module.renderedLength > 0 &&
        /\/src\/(?:.*\/)?(?:(?:testkit|fixtures?|mocks?|__fixtures__|__mocks__|__tests__)(?:\/|\.[^/]*$)|[^/]*\.(?:test|spec)\.[^/]*$)/i.test(
          module.id,
        ),
    )
    .map((module) => module.id);
}
