import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, OnInit, signal } from "@angular/core";
import { FormBuilder, ReactiveFormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterModule } from "@angular/router";

import { BrowserApi } from "@bitwarden/browser/platform/browser/browser-api";
import { PopOutComponent } from "@bitwarden/browser/platform/popup/components/pop-out.component";
import { PopupHeaderComponent } from "@bitwarden/browser/platform/popup/layout/popup-header.component";
import { PopupPageComponent } from "@bitwarden/browser/platform/popup/layout/popup-page.component";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import {
  ButtonModule,
  CalloutModule,
  DialogService,
  FormFieldModule,
  ItemModule,
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

import { BrowserSimpleLoginAliasService } from "../../alias/browser-simple-login-alias.service";

@Component({
  selector: "app-email-aliases",
  templateUrl: "./email-aliases.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonModule,
    CalloutModule,
    CommonModule,
    FormFieldModule,
    I18nPipe,
    ItemModule,
    PopOutComponent,
    PopupHeaderComponent,
    PopupPageComponent,
    ReactiveFormsModule,
    RouterModule,
  ],
})
export class EmailAliasesComponent implements OnInit {
  protected readonly aliases = signal<SimpleLoginAlias[]>([]);
  protected readonly domains = signal<SimpleLoginAliasDomain[]>([]);
  protected readonly contacts = signal<SimpleLoginContact[]>([]);
  protected readonly recommendation = signal<SimpleLoginAliasRecommendation | undefined>(undefined);
  protected readonly selectedAlias = signal<SimpleLoginAlias | undefined>(undefined);
  protected readonly loading = signal(true);
  protected readonly working = signal(false);
  protected readonly error = signal("");
  protected readonly page = signal(0);
  protected readonly nextPage = signal<number | undefined>(undefined);
  protected readonly contactsPage = signal(0);
  protected readonly contactsNextPage = signal<number | undefined>(undefined);

  protected get domainNames(): string {
    return this.domains()
      .map((domain) => domain.domain)
      .join(", ");
  }

  protected readonly searchForm = this.formBuilder.group({
    query: "",
    filter: "all" as SimpleLoginAliasFilter,
  });
  protected readonly editForm = this.formBuilder.group({ name: "", note: "" });
  protected readonly reverseAliasForm = this.formBuilder.group({ contact: "" });

  constructor(
    private readonly aliasesService: BrowserSimpleLoginAliasService,
    private readonly dialogService: DialogService,
    private readonly formBuilder: FormBuilder,
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly i18nService: I18nService,
  ) {}

  async ngOnInit() {
    const id = Number(this.route.snapshot.paramMap.get("id"));
    if (Number.isInteger(id) && id > 0) {
      await this.loadDetail(id);
      return;
    }
    await this.loadList(0);
  }

  protected async search() {
    await this.loadList(0);
  }

  protected async previous() {
    await this.loadList(Math.max(0, this.page() - 1));
  }

  protected async next() {
    if (this.nextPage() !== undefined) {
      await this.loadList(this.nextPage()!);
    }
  }

  protected async recommendOrCreate() {
    await this.run(async () => {
      const tab = await BrowserApi.getTabFromCurrentWindowId();
      await this.aliasesService.recommendOrCreate(tab?.url ?? "");
      await this.fetchList(0);
    });
  }

  protected async createRandom() {
    await this.run(async () => {
      const tab = await BrowserApi.getTabFromCurrentWindowId();
      await this.aliasesService.create({ hostname: tab?.url });
      await this.fetchList(0);
    });
  }

  protected async open(alias: SimpleLoginAlias) {
    await this.router.navigate(["/email-aliases", alias.id]);
  }

  protected async save() {
    const alias = this.selectedAlias();
    if (!alias) {
      return;
    }
    await this.run(async () => {
      const updated = await this.aliasesService.update(alias.id, {
        name: this.editForm.controls.name.value,
        note: this.editForm.controls.note.value,
      });
      this.selectedAlias.set(updated);
      this.patchEditForm(updated);
    });
  }

  protected async toggleEnabled() {
    const alias = this.selectedAlias();
    if (!alias) {
      return;
    }
    await this.run(async () => {
      this.selectedAlias.set(await this.aliasesService.setEnabled(alias.id, !alias.enabled));
    });
  }

  protected async deleteAlias() {
    const alias = this.selectedAlias();
    if (!alias) {
      return;
    }
    await this.run(async () => {
      const confirmed = await this.dialogService.openSimpleDialog({
        title: { key: "delete" },
        content: { key: "deleteEmailAliasConfirmation" },
        acceptButtonText: { key: "delete" },
        type: "warning",
      });
      if (!confirmed) {
        return;
      }
      await this.aliasesService.delete(alias.id);
      await this.router.navigate(["/email-aliases"]);
    });
  }

  protected async createReverseAlias() {
    const contact = this.reverseAliasForm.controls.contact.value?.trim();
    const alias = this.selectedAlias();
    if (!alias || !contact) {
      return;
    }
    await this.run(async () => {
      await this.aliasesService.createReverseAlias(alias.id, contact);
      this.reverseAliasForm.reset();
      await this.fetchContacts(alias, 0);
    });
  }

  protected async toggleContact(contact: SimpleLoginContact) {
    await this.run(async () => {
      const blocked = await this.aliasesService.toggleContactBlocked(contact);
      this.contacts.update((contacts) =>
        contacts.map((item) => (item.id === contact.id ? { ...item, blocked } : item)),
      );
    });
  }

  protected async deleteContact(contact: SimpleLoginContact) {
    await this.run(async () => {
      const confirmed = await this.dialogService.openSimpleDialog({
        title: { key: "delete" },
        content: { key: "deleteReverseAliasConfirmation" },
        acceptButtonText: { key: "delete" },
        type: "warning",
      });
      if (!confirmed) {
        return;
      }
      await this.aliasesService.deleteContact(contact);
      const alias = this.selectedAlias();
      if (alias) {
        await this.fetchContacts(alias, 0);
      }
    });
  }

  protected async previousContacts() {
    await this.loadContacts(Math.max(0, this.contactsPage() - 1));
  }

  protected async nextContacts() {
    if (this.contactsNextPage() !== undefined) {
      await this.loadContacts(this.contactsNextPage()!);
    }
  }

  private async loadList(page: number, showLoading = true) {
    await this.run(() => this.fetchList(page), showLoading);
  }

  private async fetchList(page: number) {
    const tab = await BrowserApi.getTabFromCurrentWindowId();
    const { query, filter } = this.searchForm.getRawValue();
    const [result, domains, recommendation] = await Promise.all([
      this.aliasesService.list(page, query?.trim() || undefined, filter ?? "all"),
      this.aliasesService.domains(),
      this.aliasesService.recommend(tab?.url ?? ""),
    ]);
    this.aliases.set(result.items);
    this.page.set(result.page);
    this.nextPage.set(result.nextPage);
    this.domains.set(domains);
    this.recommendation.set(recommendation);
  }

  private async loadDetail(id: number) {
    await this.run(async () => {
      const alias = await this.aliasesService.get(id);
      const contacts = await this.aliasesService.contacts(alias.id, 0);
      this.selectedAlias.set(alias);
      this.patchEditForm(alias);
      this.setContacts(contacts);
    });
  }

  private async loadContacts(page: number, showLoading = false) {
    const alias = this.selectedAlias();
    if (!alias) {
      return;
    }
    await this.run(() => this.fetchContacts(alias, page), showLoading);
  }

  private async fetchContacts(alias: SimpleLoginAlias, page: number) {
    this.setContacts(await this.aliasesService.contacts(alias.id, page));
  }

  private setContacts(result: { items: SimpleLoginContact[]; page: number; nextPage?: number }) {
    this.contacts.set(result.items);
    this.contactsPage.set(result.page);
    this.contactsNextPage.set(result.nextPage);
  }

  private patchEditForm(alias: SimpleLoginAlias) {
    this.editForm.setValue({ name: alias.name ?? "", note: alias.note ?? "" });
  }

  private async run(operation: () => Promise<void>, showLoading = true) {
    if (this.working()) {
      return;
    }
    this.working.set(true);
    if (showLoading) {
      this.loading.set(true);
    }
    this.error.set("");
    try {
      await operation();
    } catch (error) {
      if (error instanceof SimpleLoginAliasError && error.code === "invalid-credentials") {
        this.error.set(this.i18nService.t("aliasConfigureSimpleLogin"));
      } else if (
        error instanceof SimpleLoginAliasError &&
        error.code === "rate-limited" &&
        error.retryAfterSeconds !== undefined
      ) {
        this.error.set(this.i18nService.t("aliasRateLimited", error.retryAfterSeconds.toString()));
      } else {
        this.error.set(this.i18nService.t("aliasUnknownError"));
      }
    } finally {
      this.loading.set(false);
      this.working.set(false);
    }
  }
}
