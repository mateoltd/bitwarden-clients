import { firstValueFrom } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import {
  CreateSimpleLoginAliasRequest,
  CredentialGeneratorService,
  GeneratedCredential,
  SimpleLoginAlias,
  SimpleLoginAliasError,
  SimpleLoginAliasDomain,
  SimpleLoginAliasFilter,
  SimpleLoginAliasPage,
  SimpleLoginAliasRecommendation,
  SimpleLoginAliasService,
  SimpleLoginContactPage,
  Type,
  UpdateSimpleLoginAliasRequest,
  createSimpleLoginAliasService,
  readSimpleLoginAliasSettings,
  toSimpleLoginCredentialMetadata,
} from "@bitwarden/generator-core";

/**
 * Browser integration for the Angular-independent SimpleLogin lifecycle service.
 *
 * The provider token and base URL are read from the existing encrypted generator settings. They
 * stay in memory only long enough to construct a request-scoped lifecycle service and are never
 * copied into alias metadata, browser messages, or vault ciphers.
 */
export class BrowserSimpleLoginAliasService {
  constructor(
    private readonly accountService: AccountService,
    private readonly generatorService: CredentialGeneratorService,
    private readonly cipherService?: CipherService,
    private readonly syncService?: SyncService,
  ) {}

  async recommend(website: string): Promise<SimpleLoginAliasRecommendation> {
    return (await this.lifecycle()).recommend(website);
  }

  /** Reuse the provider recommendation when it exists; otherwise create a real alias. */
  async recommendOrCreate(website: string): Promise<GeneratedCredential> {
    const lifecycle = await this.lifecycle();
    const recommendation = await lifecycle.recommend(website);
    const alias =
      recommendation.alias ??
      (await lifecycle.create({
        hostname: recommendation.hostname,
        note: recommendation.hostname ? `Bitwarden: ${recommendation.hostname}` : "Bitwarden",
      }));

    return this.toCredential(alias, website);
  }

  async create(
    request: CreateSimpleLoginAliasRequest = {},
    website?: string,
  ): Promise<GeneratedCredential> {
    const alias = await (await this.lifecycle()).create(request);
    return this.toCredential(alias, website);
  }

  async list(
    page = 0,
    query?: string,
    aliasFilter: SimpleLoginAliasFilter = "all",
  ): Promise<SimpleLoginAliasPage> {
    return (await this.lifecycle()).list(page, query, aliasFilter);
  }

  async get(id: number): Promise<SimpleLoginAlias> {
    return (await this.lifecycle()).get(id);
  }

  async update(id: number, update: UpdateSimpleLoginAliasRequest): Promise<SimpleLoginAlias> {
    return (await this.lifecycle()).update(id, update);
  }

  async setEnabled(id: number, enabled: boolean): Promise<SimpleLoginAlias> {
    return (await this.lifecycle()).setEnabled(id, enabled);
  }

  async delete(id: number): Promise<void> {
    await (await this.lifecycle()).delete(id);
  }

  async removeConnection(): Promise<void> {
    await (await this.lifecycle()).removeConnection();
  }

  async synchronizationState() {
    return (await this.lifecycle()).synchronizationState();
  }

  async resolveSynchronizationConflict(conflictId: string, chosenEventId: string) {
    return (await this.lifecycle()).resolveSynchronizationConflict(conflictId, chosenEventId);
  }

  async domains(): Promise<SimpleLoginAliasDomain[]> {
    return (await this.lifecycle()).domains();
  }

  async contacts(aliasId: number, page = 0): Promise<SimpleLoginContactPage> {
    return (await this.lifecycle()).contacts(aliasId, page);
  }

  async createReverseAlias(aliasId: number, contact: string) {
    return (await this.lifecycle()).createReverseAlias(aliasId, contact);
  }

  async toggleContactBlocked(contactId: number): Promise<boolean> {
    return (await this.lifecycle()).toggleContactBlocked(contactId);
  }

  async deleteContact(contactId: number): Promise<void> {
    await (await this.lifecycle()).deleteContact(contactId);
  }

  private async lifecycle(): Promise<SimpleLoginAliasService> {
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

  private toCredential(alias: SimpleLoginAlias, website?: string): GeneratedCredential {
    return new GeneratedCredential(
      alias.address,
      Type.email,
      Date.now(),
      "browser-email-alias",
      website,
      toSimpleLoginCredentialMetadata(alias),
    );
  }
}
