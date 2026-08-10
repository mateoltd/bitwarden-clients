import { firstValueFrom } from "rxjs";

import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getUserId } from "@bitwarden/common/auth/services/account.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { createSimpleLoginAliasService, integration } from "@bitwarden/generator-core";
import { StateProvider } from "@bitwarden/state";

import { Response } from "../../models/response";

import { AliasReconciliationService } from "./alias-reconciliation.service";

export class AliasReconciliationCommand {
  constructor(
    private readonly cipherService: CipherService,
    private readonly accountService: AccountService,
    private readonly stateProvider: StateProvider,
    private readonly apiService: ApiService,
    private readonly syncService: SyncService,
  ) {}

  async run(apply: boolean): Promise<Response> {
    const userId = await firstValueFrom(this.accountService.activeAccount$.pipe(getUserId));
    if (!userId) {
      return Response.badRequest("No active account was found.");
    }

    const settings = await firstValueFrom(
      this.stateProvider.getUserState$(integration.SimpleLogin.forwarder.settings, userId),
    );
    if (!settings?.token?.trim()) {
      return Response.badRequest(
        "SimpleLogin is not configured. Configure the existing encrypted SimpleLogin forwarder first.",
      );
    }

    try {
      await this.syncService.fullSync(true, true);
      const service = new AliasReconciliationService(
        createSimpleLoginAliasService(this.apiService, {
          token: settings.token,
          baseUrl: settings.baseUrl,
        }),
        this.cipherService,
      );
      return Response.success(await service.reconcile(userId, apply));
    } catch (error) {
      return Response.error(error);
    }
  }
}
