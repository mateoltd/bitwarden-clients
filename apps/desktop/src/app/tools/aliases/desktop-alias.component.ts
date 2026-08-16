import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";

import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import {
  ButtonModule,
  CheckboxModule,
  DialogService,
  FormFieldModule,
  LinkModule,
  SelectModule,
  ToastService,
} from "@bitwarden/components";
import {
  SimpleLoginAlias,
  SimpleLoginAliasDomain,
  SimpleLoginAliasError,
  SimpleLoginAliasFilter,
  SimpleLoginAliasRecommendation,
  SimpleLoginContact,
} from "@bitwarden/generator-core";
import { I18nPipe } from "@bitwarden/ui-common";

import { DesktopHeaderComponent } from "../../layout/header";

import { DesktopAliasService } from "./desktop-alias.service";

type FilterOption = { value: SimpleLoginAliasFilter; name: string };

@Component({
  selector: "app-desktop-aliases",
  templateUrl: "./desktop-alias.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonModule,
    CheckboxModule,
    CommonModule,
    DesktopHeaderComponent,
    FormFieldModule,
    FormsModule,
    I18nPipe,
    LinkModule,
    SelectModule,
  ],
})
export class DesktopAliasComponent implements OnInit {
  private readonly aliasService = inject(DesktopAliasService);
  private readonly dialogService = inject(DialogService);
  private readonly i18nService = inject(I18nService);
  private readonly router = inject(Router);
  private readonly toastService = inject(ToastService);

  protected readonly aliases = signal<SimpleLoginAlias[]>([]);
  protected readonly selectedAlias = signal<SimpleLoginAlias | null>(null);
  protected readonly contacts = signal<SimpleLoginContact[]>([]);
  protected readonly domains = signal<SimpleLoginAliasDomain[]>([]);
  protected readonly boundLogins = signal<CipherView[]>([]);
  protected readonly recommendation = signal<SimpleLoginAliasRecommendation | null>(null);
  protected readonly loading = signal(false);
  protected readonly working = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly nextPage = signal<number | undefined>(undefined);
  protected readonly nextContactsPage = signal<number | undefined>(undefined);

  protected readonly search = signal("");
  protected readonly filter = signal<SimpleLoginAliasFilter>("all");
  protected readonly page = signal(0);
  protected readonly contactPage = signal(0);
  protected readonly website = signal("");
  protected readonly createHostname = signal("");
  protected readonly newContact = signal("");
  protected readonly editName = signal("");
  protected readonly editNote = signal("");
  protected readonly editPinned = signal(false);
  private readonly reloadGeneration = signal(0);

  protected readonly filterOptions: FilterOption[] = [
    { value: "all", name: this.i18nService.t("all") },
    { value: "enabled", name: this.i18nService.t("enabled") },
    { value: "disabled", name: this.i18nService.t("disabled") },
    { value: "pinned", name: this.i18nService.t("aliasPinned") },
  ];

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  protected async reload(page = 0): Promise<void> {
    const generation = this.reloadGeneration() + 1;
    this.reloadGeneration.set(generation);
    this.loading.set(true);
    this.error.set(null);
    try {
      const client = await this.aliasService.client();
      const [result, domains] = await Promise.all([
        client.list(page, this.search().trim() || undefined, this.filter()),
        client.domains(),
      ]);
      if (generation !== this.reloadGeneration()) {
        return;
      }
      this.aliases.set(result.items);
      this.domains.set(domains);
      this.page.set(result.page);
      this.nextPage.set(result.nextPage);

      const selected = this.selectedAlias();
      if (selected) {
        const retained = result.items.find((alias) => alias.id === selected.id);
        if (retained) {
          await this.selectAlias(retained);
        } else {
          this.clearSelection();
        }
      }
    } catch (error) {
      if (generation === this.reloadGeneration()) {
        this.handleError(error);
      }
    } finally {
      if (generation === this.reloadGeneration()) {
        this.loading.set(false);
      }
    }
  }

  protected async recommend(): Promise<void> {
    if (!this.website().trim()) {
      return;
    }

    await this.run(async () => {
      const recommendation = await (await this.aliasService.client()).recommend(this.website());
      this.recommendation.set(recommendation);
      if (recommendation.alias) {
        await this.loadAlias(recommendation.alias);
      }
    });
  }

  protected async createRecommended(): Promise<void> {
    const recommendation = this.recommendation();
    if (!recommendation?.canCreate) {
      return;
    }
    await this.createAlias(recommendation.hostname);
  }

  protected async createAlias(hostname = this.createHostname()): Promise<void> {
    await this.run(async () => {
      const alias = await (
        await this.aliasService.client()
      ).create({
        kind: "random",
        hostname: hostname.trim() || undefined,
      });
      this.recommendation.set(null);
      this.createHostname.set("");
      await this.reload(0);
      await this.loadAlias(alias);
      this.showSuccess("aliasCreated");
    });
  }

  protected async selectAlias(alias: SimpleLoginAlias): Promise<void> {
    await this.run(() => this.loadAlias(alias));
  }

  protected async saveAlias(): Promise<void> {
    const alias = this.selectedAlias();
    if (!alias) {
      return;
    }
    await this.run(async () => {
      const updated = await (
        await this.aliasService.client()
      ).update(alias.id, {
        name: this.editName().trim() || null,
        note: this.editNote().trim() || null,
        pinned: this.editPinned(),
      });
      this.replaceAlias(updated);
      this.showSuccess("aliasUpdated");
    });
  }

  protected async toggleAlias(): Promise<void> {
    const alias = this.selectedAlias();
    if (!alias) {
      return;
    }
    await this.run(async () => {
      const updated = await (await this.aliasService.client()).setEnabled(alias.id, !alias.enabled);
      this.replaceAlias(updated);
      this.showSuccess(updated.enabled ? "aliasEnabled" : "aliasDisabled");
    });
  }

  protected async deleteAlias(): Promise<void> {
    const alias = this.selectedAlias();
    if (!alias) {
      return;
    }

    await this.run(async () => {
      const confirmed = await this.dialogService.openSimpleDialog({
        title: { key: "aliasDeleteTitle" },
        content: { key: "aliasDeleteConfirmation", placeholders: [alias.address] },
        acceptButtonText: { key: "delete" },
        type: "warning",
      });
      if (!confirmed) {
        return;
      }
      await (await this.aliasService.client()).delete(alias.id);
      this.clearSelection();
      await this.reload(Math.max(0, this.page()));
      this.showSuccess("aliasDeleted");
    });
  }

  protected async loadContacts(page: number): Promise<void> {
    const alias = this.selectedAlias();
    if (!alias) {
      return;
    }
    await this.run(() => this.fetchContacts(alias, page));
  }

  protected async createReverseAlias(): Promise<void> {
    const alias = this.selectedAlias();
    const contact = this.newContact().trim();
    if (!alias || !contact) {
      return;
    }
    await this.run(async () => {
      await (await this.aliasService.client()).createReverseAlias(alias.id, contact);
      this.newContact.set("");
      await this.fetchContacts(alias, 0);
      this.showSuccess("reverseAliasCreated");
    });
  }

  protected async toggleContact(contact: SimpleLoginContact): Promise<void> {
    await this.run(async () => {
      const blocked = await (await this.aliasService.client()).toggleContactBlocked(contact);
      this.contacts.update((contacts) =>
        contacts.map((item) => (item.id === contact.id ? { ...item, blocked } : item)),
      );
      this.showSuccess(blocked ? "contactBlocked" : "contactUnblocked");
    });
  }

  protected async deleteContact(contact: SimpleLoginContact): Promise<void> {
    await this.run(async () => {
      const confirmed = await this.dialogService.openSimpleDialog({
        title: { key: "reverseAliasDeleteTitle" },
        content: { key: "reverseAliasDeleteConfirmation", placeholders: [contact.address] },
        acceptButtonText: { key: "delete" },
        type: "warning",
      });
      if (!confirmed) {
        return;
      }
      await (await this.aliasService.client()).deleteContact(contact);
      const alias = this.selectedAlias();
      if (alias) {
        await this.fetchContacts(alias, this.contactPage());
      }
      this.showSuccess("reverseAliasDeleted");
    });
  }

  protected async manageLogin(login: CipherView): Promise<void> {
    await this.router.navigate(["/vault"], { queryParams: { search: login.name } });
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.working()) {
      return;
    }
    this.working.set(true);
    this.error.set(null);
    try {
      await operation();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.working.set(false);
    }
  }

  private replaceAlias(alias: SimpleLoginAlias): void {
    this.selectedAlias.set(alias);
    this.aliases.update((aliases) =>
      aliases.map((existing) => (existing.id === alias.id ? alias : existing)),
    );
    this.editName.set(alias.name ?? "");
    this.editNote.set(alias.note ?? "");
    this.editPinned.set(alias.pinned);
  }

  private async loadAlias(alias: SimpleLoginAlias): Promise<void> {
    const client = await this.aliasService.client();
    const [detail, contacts, boundLogins] = await Promise.all([
      client.get(alias.id),
      client.contacts(alias.id),
      this.aliasService.boundLogins(alias),
    ]);
    this.selectedAlias.set(detail);
    this.contacts.set(contacts.items);
    this.boundLogins.set(boundLogins);
    this.contactPage.set(contacts.page);
    this.nextContactsPage.set(contacts.nextPage);
    this.editName.set(detail.name ?? "");
    this.editNote.set(detail.note ?? "");
    this.editPinned.set(detail.pinned);
  }

  private async fetchContacts(alias: SimpleLoginAlias, page: number): Promise<void> {
    const result = await (await this.aliasService.client()).contacts(alias.id, page);
    this.contacts.set(result.items);
    this.contactPage.set(result.page);
    this.nextContactsPage.set(result.nextPage);
  }

  private clearSelection(): void {
    this.selectedAlias.set(null);
    this.contacts.set([]);
    this.boundLogins.set([]);
    this.nextContactsPage.set(undefined);
  }

  private handleError(error: unknown): void {
    if (error instanceof SimpleLoginAliasError) {
      if (error.code === "invalid-credentials") {
        this.error.set(this.i18nService.t("aliasConfigureSimpleLogin"));
        return;
      }
      if (error.code === "rate-limited" && error.retryAfterSeconds != null) {
        this.error.set(this.i18nService.t("aliasRateLimited", error.retryAfterSeconds.toString()));
        return;
      }
      this.error.set(error.message);
      return;
    }
    this.error.set(this.i18nService.t("aliasUnknownError"));
  }

  private showSuccess(message: string): void {
    this.toastService.showToast({ variant: "success", message: this.i18nService.t(message) });
  }
}
