import { inject, Injectable, OnDestroy } from "@angular/core";
import { filter, firstValueFrom } from "rxjs";

import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { Account, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { Vendor } from "@bitwarden/common/tools/extension/vendor/data";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import {
  createSimpleLoginAliasService,
  CredentialGeneratorService,
  ForwarderOptions,
  SimpleLoginAlias,
  SimpleLoginAliasService,
} from "@bitwarden/generator-core";

@Injectable()
export class DesktopAliasService implements OnDestroy {
  private readonly accountService = inject(AccountService);
  private readonly apiService = inject(ApiService);
  private readonly cipherService = inject(CipherService);
  private readonly generatorService = inject(CredentialGeneratorService);

  private readonly account$ = this.accountService.activeAccount$.pipe(
    filter((account): account is Account => account != null),
  );

  private readonly settings = this.generatorService.settings<ForwarderOptions>(
    this.generatorService.forwarder(Vendor.simplelogin),
    { account$: this.account$ },
  );

  async client(): Promise<SimpleLoginAliasService> {
    const settings = await firstValueFrom(this.settings);
    return createSimpleLoginAliasService(this.apiService, {
      token: settings.token ?? "",
      baseUrl: settings.baseUrl || undefined,
    });
  }

  async boundLogins(alias: SimpleLoginAlias): Promise<CipherView[]> {
    const account = await firstValueFrom(this.account$);
    const ciphers = await this.cipherService.getAllDecrypted(account.id);
    const aliasId = alias.id.toString();
    const address = alias.address.trim().toLowerCase();

    return ciphers.filter((cipher) => {
      const binding = cipher.aliasBinding;
      return (
        !cipher.isDeleted &&
        binding?.provider === "simplelogin" &&
        binding.id === aliasId &&
        binding.address.trim().toLowerCase() === address &&
        cipher.login?.username?.trim().toLowerCase() === address
      );
    });
  }

  ngOnDestroy(): void {
    this.settings.complete();
  }
}
