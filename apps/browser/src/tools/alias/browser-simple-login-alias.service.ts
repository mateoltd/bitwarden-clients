import { filter, firstValueFrom } from "rxjs";

import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { Account, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { Vendor } from "@bitwarden/common/tools/extension/vendor/data";
import {
  CreateSimpleLoginAliasRequest,
  CredentialGeneratorService,
  ForwarderOptions,
  GeneratedCredential,
  SimpleLoginAlias,
  SimpleLoginAliasDomain,
  SimpleLoginAliasFilter,
  SimpleLoginAliasPage,
  SimpleLoginAliasRecommendation,
  SimpleLoginAliasService,
  SimpleLoginContactPage,
  Type,
  UpdateSimpleLoginAliasRequest,
  createSimpleLoginAliasService,
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
  private readonly settings$ = this.generatorService.settings<ForwarderOptions>(
    this.generatorService.forwarder(Vendor.simplelogin),
    {
      account$: this.accountService.activeAccount$.pipe(
        filter((account): account is Account => account !== null),
      ),
    },
  );

  constructor(
    private readonly apiService: ApiService,
    private readonly accountService: AccountService,
    private readonly generatorService: CredentialGeneratorService,
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
    const settings = await firstValueFrom(this.settings$);
    return createSimpleLoginAliasService(this.apiService, {
      token: settings.token ?? "",
      baseUrl: settings.baseUrl,
    });
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
