import { firstValueFrom } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getUserId } from "@bitwarden/common/auth/services/account.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import {
  AliasSyncStore,
  createAliasSyncDocument,
  mergeAliasSyncDocuments,
  parseAliasSyncDocument,
} from "@bitwarden/common/tools/alias";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { AliasConnectionVaultStore } from "@bitwarden/common/vault/alias-connection";
import {
  createSimpleLoginAliasService,
  integration,
  isSimpleLoginConnectionId,
} from "@bitwarden/generator-core";
import { StateProvider } from "@bitwarden/state";

import { Response } from "../../models/response";

import { AliasReconciliationService } from "./alias-reconciliation.service";

type AliasReconciliationCommandCipherService = Pick<
  CipherService,
  | "clearCache"
  | "createWithServer"
  | "getAllDecrypted"
  | "getAllDecryptedIncludingInternal"
  | "updateWithServer"
>;

export class AliasReconciliationCommand {
  constructor(
    private readonly cipherService: AliasReconciliationCommandCipherService,
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

    if (!isSimpleLoginConnectionId(settings.connectionId)) {
      return Response.badRequest(
        "SimpleLogin is not configured with a valid persisted connection identity.",
      );
    }
    const connectionId = settings.connectionId;

    try {
      await this.syncService.fullSync(true, true);
      const unjournaled = createSimpleLoginAliasService({
        token: settings.token,
        baseUrl: settings.baseUrl,
        connectionId,
      });
      let syncStore: AliasSyncStore | undefined;
      if (apply) {
        const local: AliasSyncStore = {
          load: async () => {
            const current = await firstValueFrom(
              this.stateProvider.getUserState$(integration.SimpleLogin.forwarder.settings, userId),
            );
            return current?.aliasSync
              ? parseAliasSyncDocument(current.aliasSync)
              : createAliasSyncDocument();
          },
          save: async (document) => {
            const current = await firstValueFrom(
              this.stateProvider.getUserState$(integration.SimpleLogin.forwarder.settings, userId),
            );
            const stored = current?.aliasSync
              ? parseAliasSyncDocument(current.aliasSync)
              : createAliasSyncDocument(document.replicaId);
            await this.stateProvider.setUserState(
              integration.SimpleLogin.forwarder.settings,
              { ...current, aliasSync: mergeAliasSyncDocuments(stored, document) },
              userId,
            );
          },
        };
        const provider = unjournaled.providerIdentity();
        syncStore = new AliasConnectionVaultStore({
          cipherService: this.cipherService,
          userId,
          connection: {
            provider: provider.provider,
            providerInstance: provider.instance,
            connectionId: provider.connectionId,
          },
          credential: { token: settings.token, baseUrl: provider.instance },
          local,
          refresh: async () => {
            await this.syncService.fullSync(true, { allowThrowOnError: true });
          },
        });
      }
      const service = new AliasReconciliationService(
        createSimpleLoginAliasService({
          token: settings.token,
          baseUrl: settings.baseUrl,
          connectionId,
          syncStore,
        }),
        this.cipherService,
      );
      return Response.success(await service.reconcile(userId, apply));
    } catch (error) {
      return Response.error(error);
    }
  }
}
