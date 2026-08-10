import { Command, program } from "commander";

import { BaseProgram } from "../../base-program";
import { CliUtils } from "../../utils";

import { AliasReconciliationCommand } from "./alias-reconciliation.command";

const writeLn = CliUtils.writeLn;

export class AliasReconciliationProgram extends BaseProgram {
  async register(): Promise<void> {
    const aliases = new Command("aliases").description(
      "Reconcile first-class email aliases with login items.",
    );

    aliases
      .command("reconcile")
      .description(
        "Compare SimpleLogin aliases with login items. Defaults to a machine-readable dry run.",
      )
      .option(
        "--apply",
        "Apply only safe one-to-one bindings. Duplicate, conflicting, and missing records are never changed.",
      )
      .on("--help", () => {
        writeLn("\n  Notes:");
        writeLn("");
        writeLn("    Output is a versioned JSON report. Without --apply, the vault is not modified.");
        writeLn("    --apply binds only one unbound login to one exact live alias address.");
        writeLn("");
        writeLn("  Examples:");
        writeLn("");
        writeLn("    bw aliases reconcile --pretty");
        writeLn("    bw aliases reconcile --apply --pretty");
        writeLn("", true);
      })
      .action(async (options) => {
        await this.exitIfLocked();
        const command = new AliasReconciliationCommand(
          this.serviceContainer.cipherService,
          this.serviceContainer.accountService,
          this.serviceContainer.stateProvider,
          this.serviceContainer.apiService,
          this.serviceContainer.syncService,
        );
        this.processResponse(await command.run(options.apply === true));
      });

    program.addCommand(aliases);
  }
}
