import { firstValueFrom } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getUserId } from "@bitwarden/common/auth/services/account.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import {
  createSimpleLoginAliasService,
  createSimpleLoginConnectionId,
  integration,
  isSimpleLoginConnectionId,
} from "@bitwarden/generator-core";
import { StateProvider } from "@bitwarden/state";

import { Response } from "../../models/response";

import { AliasReconciliationService } from "./alias-reconciliation.service";

export class AliasReconciliationCommand {
  constructor(
    private readonly cipherService: CipherService,
    private readonly accountService: AccountService,
    private readonly stateProvider: StateProvider,
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

    let connectionId = settings.connectionId;
    if (connectionId !== undefined && !isSimpleLoginConnectionId(connectionId)) {
      return Response.badRequest("The stored SimpleLogin connection identity is invalid.");
    }
    if (!connectionId) {
      connectionId = createSimpleLoginConnectionId();
      await this.stateProvider.setUserState(
        integration.SimpleLogin.forwarder.settings,
        { ...settings, connectionId },
        userId,
      );
    }

    try {
      await this.syncService.fullSync(true, true);
      const service = new AliasReconciliationService(
        createSimpleLoginAliasService({
          token: settings.token,
          baseUrl: settings.baseUrl,
          connectionId,
        }),
        this.cipherService,
      );
      return Response.success(await service.reconcile(userId, apply));
    } catch (error) {
      return Response.error(error);
    }
  }
}
