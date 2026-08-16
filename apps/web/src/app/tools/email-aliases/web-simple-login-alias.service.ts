import { Injectable } from "@angular/core";
import { firstValueFrom } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import {
  CreateSimpleLoginAliasRequest,
  CredentialGeneratorService,
  createSimpleLoginAliasService,
  readSimpleLoginAliasSettings,
  SimpleLoginAlias,
  SimpleLoginAliasError,
  SimpleLoginAliasDomain,
  SimpleLoginAliasFilter,
  SimpleLoginAliasPage,
  SimpleLoginAliasRecommendation,
  SimpleLoginContact,
  SimpleLoginContactPage,
  UpdateSimpleLoginAliasRequest,
} from "@bitwarden/generator-core";

@Injectable({ providedIn: "root" })
export class WebSimpleLoginAliasService {
  constructor(
    private readonly accountService: AccountService,
    private readonly generatorService: CredentialGeneratorService,
    private readonly cipherService?: CipherService,
    private readonly syncService?: SyncService,
  ) {}

  async isConfigured(): Promise<boolean> {
    try {
      await this.service();
      return true;
    } catch {
      return false;
    }
  }

  async recommend(website: string): Promise<SimpleLoginAliasRecommendation> {
    return (await this.service()).recommend(website);
  }

  async create(request: CreateSimpleLoginAliasRequest): Promise<SimpleLoginAlias> {
    return (await this.service()).create(request);
  }

  async list(
    page: number,
    query: string,
    filter: SimpleLoginAliasFilter,
  ): Promise<SimpleLoginAliasPage> {
    return (await this.service()).list(page, query || undefined, filter);
  }

  async get(id: number): Promise<SimpleLoginAlias> {
    return (await this.service()).get(id);
  }

  async update(id: number, update: UpdateSimpleLoginAliasRequest): Promise<SimpleLoginAlias> {
    return (await this.service()).update(id, update);
  }

  async setEnabled(id: number, enabled: boolean): Promise<SimpleLoginAlias> {
    return (await this.service()).setEnabled(id, enabled);
  }

  async delete(id: number): Promise<void> {
    return (await this.service()).delete(id);
  }

  async removeConnection(): Promise<void> {
    await (await this.service()).removeConnection();
  }

  async synchronizationState() {
    return (await this.service()).synchronizationState();
  }

  async resolveSynchronizationConflict(conflictId: string, chosenEventId: string) {
    return (await this.service()).resolveSynchronizationConflict(conflictId, chosenEventId);
  }

  async domains(): Promise<SimpleLoginAliasDomain[]> {
    return (await this.service()).domains();
  }

  async contacts(aliasId: number, page: number): Promise<SimpleLoginContactPage> {
    return (await this.service()).contacts(aliasId, page);
  }

  async createReverseAlias(aliasId: number, contact: string): Promise<SimpleLoginContact> {
    return (await this.service()).createReverseAlias(aliasId, contact);
  }

  async toggleContactBlocked(contact: SimpleLoginContact): Promise<boolean> {
    return (await this.service()).toggleContactBlocked(contact);
  }

  async deleteContact(contact: SimpleLoginContact): Promise<void> {
    return (await this.service()).deleteContact(contact);
  }

  private async service() {
    const account = await firstValueFrom(this.accountService.activeAccount$);
    if (!account) {
      throw new SimpleLoginAliasError("SimpleLogin credentials are missing", "invalid-credentials");
    }
    return createSimpleLoginAliasService(
      await readSimpleLoginAliasSettings(
        this.generatorService,
        account,
        this.cipherService,
        this.syncService,
      ),
    );
  }
}
