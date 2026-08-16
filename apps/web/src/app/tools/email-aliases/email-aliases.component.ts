import { Component, OnInit } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";

import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { DialogService } from "@bitwarden/components";
import {
  SimpleLoginAlias,
  SimpleLoginAliasDomain,
  SimpleLoginAliasFilter,
  SimpleLoginAliasRecommendation,
  SimpleLoginContact,
} from "@bitwarden/generator-core";

import { HeaderModule } from "../../layouts/header/header.module";
import { SharedModule } from "../../shared";

import { WebSimpleLoginAliasService } from "./web-simple-login-alias.service";

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "app-email-aliases",
  templateUrl: "email-aliases.component.html",
  imports: [SharedModule, HeaderModule],
})
export class EmailAliasesComponent implements OnInit {
  configured = false;
  loading = true;
  aliases: SimpleLoginAlias[] = [];
  domains: SimpleLoginAliasDomain[] = [];
  selected?: SimpleLoginAlias;
  contacts: SimpleLoginContact[] = [];
  recommendation?: SimpleLoginAliasRecommendation;
  error?: string;

  query = "";
  filter: SimpleLoginAliasFilter = "all";
  page = 0;
  nextPage?: number;
  contactPage = 0;
  nextContactPage?: number;
  website = "";
  reverseAliasContact = "";
  saving = false;
  working = false;

  constructor(
    private readonly aliasesService: WebSimpleLoginAliasService,
    private readonly dialogService: DialogService,
    private readonly i18nService: I18nService,
    private readonly route: ActivatedRoute,
    private readonly router: Router,
  ) {}

  async ngOnInit(): Promise<void> {
    await this.run(async () => {
      this.configured = await this.aliasesService.isConfigured();
      if (!this.configured) {
        return;
      }

      await Promise.all([this.loadAliases(0), this.loadDomains()]);

      const aliasId = Number(this.route.snapshot.queryParamMap.get("aliasId"));
      if (Number.isInteger(aliasId) && aliasId > 0) {
        await this.selectAlias(aliasId);
      }
    });
    this.loading = false;
  }

  async search(): Promise<void> {
    await this.run(() => this.loadAliases(0));
  }

  async selectFilter(filter: string): Promise<void> {
    this.filter = filter as SimpleLoginAliasFilter;
    await this.search();
  }

  async previousAliases(): Promise<void> {
    if (this.page > 0) {
      await this.run(() => this.loadAliases(this.page - 1));
    }
  }

  async nextAliases(): Promise<void> {
    if (this.nextPage !== undefined) {
      await this.run(() => this.loadAliases(this.nextPage!));
    }
  }

  async recommend(): Promise<void> {
    this.recommendation = undefined;
    await this.run(async () => {
      this.recommendation = await this.aliasesService.recommend(this.website);
    });
  }

  async createAlias(): Promise<void> {
    this.saving = true;
    try {
      await this.run(async () => {
        const alias = await this.aliasesService.create({
          kind: "random",
          hostname: this.website || undefined,
        });
        this.recommendation = undefined;
        await this.loadAliases(0);
        await this.selectAlias(alias.id);
      });
    } finally {
      this.saving = false;
    }
  }

  async openAlias(aliasOrId: SimpleLoginAlias | number): Promise<void> {
    const id = typeof aliasOrId === "number" ? aliasOrId : aliasOrId.id;
    await this.run(() => this.selectAlias(id));
  }

  private async selectAlias(id: number): Promise<void> {
    this.selected = await this.aliasesService.get(id);
    this.contactPage = 0;
    await this.loadContacts(0);
    await this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { aliasId: id },
      queryParamsHandling: "merge",
      replaceUrl: true,
    });
  }

  async closeAlias(): Promise<void> {
    this.selected = undefined;
    this.contacts = [];
    await this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { aliasId: null },
      queryParamsHandling: "merge",
      replaceUrl: true,
    });
  }

  async saveAlias(): Promise<void> {
    if (!this.selected) {
      return;
    }

    this.saving = true;
    try {
      await this.run(async () => {
        this.selected = await this.aliasesService.update(this.selected!.id, {
          name: this.selected!.name,
          note: this.selected!.note,
          pinned: this.selected!.pinned,
          pgpDisabled: this.selected!.pgpDisabled,
          mailboxIds: this.selected!.mailboxes.map((mailbox) => mailbox.id),
        });
        await this.loadAliases(this.page);
      });
    } finally {
      this.saving = false;
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (!this.selected) {
      return;
    }

    await this.run(async () => {
      this.selected = await this.aliasesService.setEnabled(this.selected!.id, enabled);
      this.replaceListedAlias(this.selected);
    });
  }

  async deleteAlias(): Promise<void> {
    if (!this.selected) {
      return;
    }

    await this.run(async () => {
      const confirmed = await this.dialogService.openSimpleDialog({
        title: { key: "deleteEmailAlias" },
        content: { key: "deleteEmailAliasConfirmation" },
        acceptButtonText: { key: "delete" },
        type: "warning",
      });
      if (!confirmed) {
        return;
      }
      const deletedAliasId = this.selected!.id;
      await this.aliasesService.delete(deletedAliasId);
      if (this.recommendation?.alias?.id === deletedAliasId) {
        this.recommendation = undefined;
      }
      await this.closeAlias();
      await this.loadAliases(this.page);
    });
  }

  async createReverseAlias(): Promise<void> {
    const contact = this.reverseAliasContact.trim();
    if (!this.selected || !contact) {
      return;
    }

    await this.run(async () => {
      await this.aliasesService.createReverseAlias(this.selected!.id, contact);
      this.reverseAliasContact = "";
      await this.loadContacts(0);
    });
  }

  async toggleContact(contact: SimpleLoginContact): Promise<void> {
    await this.run(async () => {
      contact.blocked = await this.aliasesService.toggleContactBlocked(contact);
    });
  }

  async removeContact(contact: SimpleLoginContact): Promise<void> {
    await this.run(async () => {
      const confirmed = await this.dialogService.openSimpleDialog({
        title: { key: "deleteReverseAlias" },
        content: { key: "deleteReverseAliasConfirmation" },
        acceptButtonText: { key: "delete" },
        type: "warning",
      });
      if (!confirmed) {
        return;
      }
      await this.aliasesService.deleteContact(contact);
      await this.loadContacts(this.contactPage);
    });
  }

  async previousContacts(): Promise<void> {
    if (this.contactPage > 0) {
      await this.run(() => this.loadContacts(this.contactPage - 1));
    }
  }

  async nextContacts(): Promise<void> {
    if (this.nextContactPage !== undefined) {
      await this.run(() => this.loadContacts(this.nextContactPage!));
    }
  }

  private async loadAliases(page: number): Promise<void> {
    const result = await this.aliasesService.list(page, this.query.trim(), this.filter);
    this.aliases = result.items;
    this.page = result.page;
    this.nextPage = result.nextPage;
  }

  private async loadDomains(): Promise<void> {
    this.domains = await this.aliasesService.domains();
  }

  private async loadContacts(page: number): Promise<void> {
    if (!this.selected) {
      return;
    }
    const result = await this.aliasesService.contacts(this.selected.id, page);
    this.contacts = result.items;
    this.contactPage = result.page;
    this.nextContactPage = result.nextPage;
  }

  private replaceListedAlias(alias: SimpleLoginAlias): void {
    const index = this.aliases.findIndex((listed) => listed.id === alias.id);
    if (index >= 0) {
      this.aliases[index] = alias;
    }
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.working) {
      return;
    }
    this.working = true;
    this.error = undefined;
    try {
      await action();
    } catch (error) {
      this.error = error instanceof Error ? error.message : this.i18nService.t("unexpectedError");
    } finally {
      this.working = false;
    }
  }
}
