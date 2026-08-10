import { inject, Injectable } from "@angular/core";
import { firstValueFrom } from "rxjs";

import { DialogService } from "@bitwarden/components";
import { GeneratedCredential, Type } from "@bitwarden/generator-core";
import { CipherFormGenerationService } from "@bitwarden/vault";

import { CredentialGeneratorDialogComponent } from "../vault/app/vault/credential-generator-dialog.component";

@Injectable()
export class DesktopCredentialGenerationService implements CipherFormGenerationService {
  private dialogService = inject(DialogService);

  async generatePassword(): Promise<GeneratedCredential | null> {
    return await this.generateCredential("password");
  }

  async generateUsername(uri: string): Promise<GeneratedCredential | null> {
    return await this.generateCredential("username", uri);
  }

  async generateCredential(
    type: "password" | "username",
    uri?: string,
  ): Promise<GeneratedCredential | null> {
    const dialogRef = CredentialGeneratorDialogComponent.open(this.dialogService, { type, uri });

    const result = await firstValueFrom(dialogRef.closed);

    if (!result || result.action === "canceled" || !result.generatedValue) {
      return null;
    }

    return (
      result.generatedCredential ??
      new GeneratedCredential(
        result.generatedValue,
        type === "password" ? Type.password : Type.username,
        Date.now(),
      )
    );
  }
}
