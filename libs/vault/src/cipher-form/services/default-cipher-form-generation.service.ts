import { Injectable } from "@angular/core";

import { GeneratedCredential, Type } from "@bitwarden/generator-core";
import {
  PasswordGenerationServiceAbstraction,
  UsernameGenerationServiceAbstraction,
} from "@bitwarden/generator-legacy";

import { CipherFormGenerationService } from "../abstractions/cipher-form-generation.service";

@Injectable()
export class DefaultCipherFormGenerationService implements CipherFormGenerationService {
  constructor(
    private passwordGenerationService: PasswordGenerationServiceAbstraction,
    private usernameGenerationService: UsernameGenerationServiceAbstraction,
  ) {}

  async generatePassword(): Promise<GeneratedCredential> {
    const [options] = await this.passwordGenerationService.getOptions();
    const value = await this.passwordGenerationService.generatePassword(options);
    return new GeneratedCredential(value, Type.password, Date.now());
  }

  async generateUsername(): Promise<GeneratedCredential> {
    const options = await this.usernameGenerationService.getOptions();
    const value = await this.usernameGenerationService.generateUsername(options);
    return new GeneratedCredential(value, Type.username, Date.now());
  }
}
