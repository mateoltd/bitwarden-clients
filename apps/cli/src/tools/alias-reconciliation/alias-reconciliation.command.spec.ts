import { mock } from "jest-mock-extended";
import { of } from "rxjs";

import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { StateProvider } from "@bitwarden/state";

import { AliasReconciliationCommand } from "./alias-reconciliation.command";
import { AliasReconciliationReport } from "./alias-reconciliation.service";

describe("AliasReconciliationCommand", () => {
  const userId = "user-id" as UserId;
  const token = "simplelogin-provider-token";
  const cipherService = mock<CipherService>();
  const accountService = mock<AccountService>();
  const stateProvider = mock<StateProvider>();
  const apiService = mock<ApiService>();
  const syncService = mock<SyncService>();
  const command = new AliasReconciliationCommand(
    cipherService,
    accountService,
    stateProvider,
    apiService,
    syncService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    accountService.activeAccount$ = of({ id: userId } as any);
    syncService.fullSync.mockResolvedValue(true);
    cipherService.getAllDecrypted.mockResolvedValue([]);
  });

  it("requires the existing encrypted SimpleLogin configuration", async () => {
    stateProvider.getUserState$.mockReturnValue(of({ token: "", baseUrl: "" }));

    const response = await command.run(false);

    expect(response.success).toBe(false);
    expect(response.message).toContain("SimpleLogin is not configured");
    expect(syncService.fullSync).not.toHaveBeenCalled();
  });

  it("syncs, uses the real provider transport and emits token-free machine-readable output", async () => {
    stateProvider.getUserState$.mockReturnValue(of({ token, baseUrl: "https://simplelogin.test" }));
    apiService.nativeFetch.mockImplementation(async (request) => {
      expect(request.headers.get("Authentication")).toBe(token);
      return new globalThis.Response(
        JSON.stringify({
          aliases: [
            {
              id: 7,
              email: "provider-only@sl.test",
              enabled: true,
              creation_timestamp: 1,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const response = await command.run(false);
    const report = response.data as AliasReconciliationReport;

    expect(response.success).toBe(true);
    expect(syncService.fullSync).toHaveBeenCalledWith(true, true);
    expect(report).toMatchObject({
      object: "aliasReconciliation",
      version: 1,
      mode: "dry-run",
      summary: { aliasesScanned: 1, missing: 1, appliedChanges: 0 },
    });
    expect(JSON.stringify(report)).not.toContain(token);
  });
});
