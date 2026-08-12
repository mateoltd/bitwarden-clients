import { mock } from "jest-mock-extended";
import { of } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { StateProvider } from "@bitwarden/state";

import { AliasReconciliationCommand } from "./alias-reconciliation.command";

describe("AliasReconciliationCommand", () => {
  const userId = "user-id" as UserId;
  const token = "simplelogin-provider-token";
  const cipherService = mock<CipherService>();
  const accountService = mock<AccountService>();
  const stateProvider = mock<StateProvider>();
  const syncService = mock<SyncService>();
  const command = new AliasReconciliationCommand(
    cipherService,
    accountService,
    stateProvider,
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

  it("rejects a malformed persisted connection identity before syncing", async () => {
    stateProvider.getUserState$.mockReturnValue(
      of({ token, baseUrl: "https://simplelogin.test", connectionId: "invalid" }),
    );

    const response = await command.run(false);

    expect(response.success).toBe(false);
    expect(response.message).toContain("valid persisted connection identity");
    expect(stateProvider.setUserState).not.toHaveBeenCalled();
    expect(syncService.fullSync).not.toHaveBeenCalled();
  });

  it("rejects a missing connection identity without writing settings", async () => {
    stateProvider.getUserState$.mockReturnValue(of({ token, baseUrl: "https://simplelogin.test" }));

    const response = await command.run(false);

    expect(response.success).toBe(false);
    expect(response.message).toContain("valid persisted connection identity");
    expect(stateProvider.setUserState).not.toHaveBeenCalled();
    expect(syncService.fullSync).not.toHaveBeenCalled();
  });
});
