import { inject, Injectable } from "@angular/core";
import { firstValueFrom } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import {
  createSimpleLoginAliasService,
  CredentialGeneratorService,
  readSimpleLoginAliasSettings,
  SimpleLoginAlias,
  SimpleLoginAliasError,
  SimpleLoginAliasService,
} from "@bitwarden/generator-core";

@Injectable()
export class DesktopAliasService {
  private readonly accountService = inject(AccountService);
  private readonly cipherService = inject(CipherService);
  private readonly generatorService = inject(CredentialGeneratorService);

  async client(): Promise<SimpleLoginAliasService> {
    const account = await firstValueFrom(this.accountService.activeAccount$);
    if (!account) {
      throw new SimpleLoginAliasError("SimpleLogin credentials are missing", "invalid-credentials");
    }
    return createSimpleLoginAliasService(
      await readSimpleLoginAliasSettings(this.generatorService, account),
    );
  }

  async boundLogins(alias: SimpleLoginAlias): Promise<CipherView[]> {
    const account = await firstValueFrom(this.accountService.activeAccount$);
    if (!account) {
      return [];
    }
    const ciphers = await this.cipherService.getAllDecrypted(account.id);
    const aliasId = alias.id.toString();
    const address = alias.address.trim().toLowerCase();

    return ciphers.filter((cipher) => {
      const binding = cipher.aliasBinding;
      return (
        !cipher.isDeleted &&
        binding?.provider === "simplelogin" &&
        binding.aliasId === aliasId &&
        binding.address.trim().toLowerCase() === address &&
        cipher.login?.username?.trim().toLowerCase() === address
      );
    });
  }
}
