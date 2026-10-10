import { FactoryConnection, type FactoryConnectionApi } from "./FactoryConnection";

export function shouldUseFactoryFixture(
  development: boolean,
  fixtureFlag: string | undefined,
): boolean {
  return development && fixtureFlag === "1";
}

export async function createFactoryConnection(): Promise<FactoryConnectionApi> {
  if (
    import.meta.env.DEV &&
    shouldUseFactoryFixture(import.meta.env.DEV, import.meta.env.VITE_FACTORY_FIXTURE)
  ) {
    const { createFakeFactoryConnection } = await import("./fixtures/FakeFactoryConnection");
    return createFakeFactoryConnection();
  }
  return new FactoryConnection();
}
