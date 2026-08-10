import { Injectable } from "@angular/core";
import { ReplaySubject, firstValueFrom } from "rxjs";

import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { Account, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { Vendor } from "@bitwarden/common/tools/extension/vendor/data";
import {
  CreateSimpleLoginAliasRequest,
  CredentialGeneratorService,
  ForwarderOptions,
  createSimpleLoginAliasService,
  SimpleLoginAlias,
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
    private readonly apiService: ApiService,
    private readonly accountService: AccountService,
    private readonly generatorService: CredentialGeneratorService,
  ) {}

  async isConfigured(): Promise<boolean> {
    try {
      return Boolean((await this.settings()).token?.trim());
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

  async domains(): Promise<SimpleLoginAliasDomain[]> {
    return (await this.service()).domains();
  }

  async contacts(aliasId: number, page: number): Promise<SimpleLoginContactPage> {
    return (await this.service()).contacts(aliasId, page);
  }

  async createReverseAlias(aliasId: number, contact: string): Promise<SimpleLoginContact> {
    return (await this.service()).createReverseAlias(aliasId, contact);
  }

  async toggleContactBlocked(contactId: number): Promise<boolean> {
    return (await this.service()).toggleContactBlocked(contactId);
  }

  async deleteContact(contactId: number): Promise<void> {
    return (await this.service()).deleteContact(contactId);
  }

  private async service() {
    const settings = await this.settings();
    return createSimpleLoginAliasService(this.apiService, {
      token: settings.token ?? "",
      baseUrl: settings.baseUrl || undefined,
    });
  }

  /** Read account-scoped encrypted settings for one request, then release the decrypted buffer. */
  private async settings(): Promise<ForwarderOptions> {
    const account = await firstValueFrom(this.accountService.activeAccount$);
    if (!account) {
      return {};
    }

    const account$ = new ReplaySubject<Account>(1);
    account$.next(account);
    const settings$ = this.generatorService.settings<ForwarderOptions>(
      this.generatorService.forwarder(Vendor.simplelogin),
      { account$ },
    );
    try {
      return await firstValueFrom(settings$);
    } finally {
      account$.complete();
      settings$.complete();
    }
  }
}
