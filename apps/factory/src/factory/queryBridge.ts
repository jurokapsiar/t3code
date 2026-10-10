import type { QueryClient } from "@tanstack/react-query";
import type { FactoryOverviewSnapshot } from "@t3tools/contracts/factory";
import type { FactoryConnectionApi, StreamLease } from "./FactoryConnection";
import { applyOverviewEvent } from "./overviewReducer";
import { factoryKeys, isProtectedSourceQuery } from "./queryKeys";

export class FactoryQueryBridge {
  private readonly connection: FactoryConnectionApi;
  private readonly queryClient: QueryClient;
  private factoryId: string | undefined;
  private overviewLease: StreamLease | undefined;
  private unsubscribeStatus: (() => void) | undefined;
  private stopped = false;
  private unsubscribeSourceAccess: (() => void) | undefined;

  constructor(connection: FactoryConnectionApi, queryClient: QueryClient) {
    this.connection = connection;
    this.queryClient = queryClient;
  }

  start(): void {
    if (this.unsubscribeStatus !== undefined) return;
    this.stopped = false;
    this.unsubscribeSourceAccess = this.connection.subscribeSourceAccess((event) => {
      if (event.state !== "blocked" || this.factoryId === undefined || this.stopped) return;
      const filters = {
        predicate: (query: { queryKey: readonly unknown[] }) =>
          isProtectedSourceQuery(query.queryKey, this.factoryId!, event.target),
      };
      // The owner has already invalidated leases. Cancel retryers before eviction
      // so neither a late read nor a stream callback can restore protected data.
      void this.queryClient.cancelQueries(filters);
      this.queryClient.removeQueries(filters);
    });
    this.unsubscribeStatus = this.connection.subscribeStatus((status) => this.handleStatus(status));
    this.handleStatus(this.connection.status);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = undefined;
    this.unsubscribeSourceAccess?.();
    this.unsubscribeSourceAccess = undefined;
    this.releaseOverview();
  }

  private handleStatus(status: FactoryConnectionApi["status"]): void {
    if (
      status.phase === "unauthenticated" ||
      (status.phase === "blocked" && status.reason === "permission")
    ) {
      this.releaseOverview();
      this.queryClient.removeQueries({ queryKey: ["factory"] });
      this.factoryId = undefined;
      return;
    }
    if (status.reason === "overview-too-large" && this.factoryId !== undefined) {
      const factoryId = this.factoryId;
      const filters = {
        predicate: (query: { queryKey: readonly unknown[] }) =>
          query.queryKey[0] === "factory" &&
          query.queryKey[1] === factoryId &&
          ["overview", "source", "embedded-route", "environments"].includes(
            String(query.queryKey[2]),
          ),
      };
      void this.queryClient.cancelQueries(filters);
      this.queryClient.removeQueries(filters);
      return;
    }
    if (status.phase !== "synchronizing" && status.phase !== "online") return;
    const factoryId = this.connection.factoryId;
    if (factoryId === undefined || this.stopped) return;
    if (this.factoryId !== undefined && this.factoryId !== factoryId) {
      const previousFactoryId = this.factoryId;
      this.releaseOverview();
      this.queryClient.removeQueries({ queryKey: factoryKeys.root(previousFactoryId) });
    }
    this.factoryId = factoryId;
    if (this.overviewLease === undefined) this.acquireOverview(factoryId);
  }

  private acquireOverview(factoryId: string): void {
    const key = JSON.stringify(factoryKeys.overview(factoryId));
    this.overviewLease = this.connection.acquireStream(
      key,
      (client) => client["factory.overview.subscribe"]({}),
      (event) => {
        if (this.factoryId !== factoryId || this.stopped) return;
        const queryKey = factoryKeys.overview(factoryId);
        const current = this.queryClient.getQueryData<FactoryOverviewSnapshot>(queryKey);
        const result = applyOverviewEvent(current, event);
        if (result.kind === "applied") {
          this.connection.updateSourceAccess(result.value);
          if (current?.environments !== result.value.environments) {
            this.queryClient.setQueryData(
              factoryKeys.environments(factoryId),
              result.value.environments,
            );
          }
          this.queryClient.setQueryData(queryKey, result.value);
        } else if (result.kind === "reset-required") {
          this.queryClient.removeQueries({ queryKey, exact: true });
          this.queryClient.removeQueries({
            queryKey: factoryKeys.environments(factoryId),
            exact: true,
          });
          this.restartOverview(factoryId);
        }
      },
    );
  }

  private restartOverview(factoryId: string): void {
    if (this.factoryId !== factoryId || this.connection.factoryId !== factoryId || this.stopped)
      return;
    this.releaseOverview();
    this.acquireOverview(factoryId);
  }

  private releaseOverview(): void {
    this.overviewLease?.release();
    this.overviewLease = undefined;
  }
}
