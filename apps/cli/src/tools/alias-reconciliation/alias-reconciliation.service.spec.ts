import { mock } from "jest-mock-extended";

import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import {
  ALIAS_BINDING_FIELD_NAME,
  hydrateAliasBinding,
} from "@bitwarden/common/vault/alias-binding";
import { CipherType, FieldType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { FieldView } from "@bitwarden/common/vault/models/view/field.view";
import { SimpleLoginAliasError, SimpleLoginAliasService } from "@bitwarden/generator-core";
import { Alias, AliasProviderIdentity, SensitiveString } from "@bitwarden/sdk-internal";

import { AliasReconciliationService } from "./alias-reconciliation.service";

const userId = "11111111-1111-4111-8111-111111111111" as UserId;
const connectionId = "22222222-2222-4222-8222-222222222222";
const provider: AliasProviderIdentity = {
  provider: "simplelogin",
  instance: "https://app.simplelogin.io/",
  connectionId,
};
const sensitive = (value: string): SensitiveString => value as SensitiveString;

function sdkAlias(id: number, address: string): Alias {
  return {
    id: BigInt(id),
    email: sensitive(address),
    creation_date: "2026-08-12T00:00:00Z",
    creation_timestamp: BigInt(1),
    enabled: true,
    note: undefined,
    name: undefined,
    nb_forward: BigInt(0),
    nb_block: BigInt(0),
    nb_reply: BigInt(0),
    mailbox: { id: BigInt(1), email: sensitive("owner@example.test") },
    mailboxes: [{ id: BigInt(1), email: sensitive("owner@example.test") }],
    support_pgp: false,
    disable_pgp: false,
    latest_activity: undefined,
    pinned: false,
  };
}

function cipherId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function login(index: number, username: string, aliasId?: number): CipherView {
  const cipher = new CipherView();
  cipher.id = cipherId(index);
  cipher.type = CipherType.Login;
  cipher.login.username = username;
  if (aliasId !== undefined) {
    cipher.aliasBinding = {
      version: 2,
      provider: "simplelogin",
      providerInstance: provider.instance,
      connectionId,
      aliasId: aliasId.toString(),
      address: username,
    };
  }
  return cipher;
}

function serviceWithAliases(aliases: Alias[]): SimpleLoginAliasService {
  const aliasService = mock<SimpleLoginAliasService>();
  aliasService.providerIdentity.mockReturnValue(provider);
  aliasService.listCanonical.mockImplementation(async (page) => ({
    aliases: page === 0 ? aliases : [],
    page,
  }));
  return aliasService;
}

describe("alias reconciliation", () => {
  it("uses the SDK to detect exact, duplicate, conflict, missing and unbound records", async () => {
    const aliases = [
      sdkAlias(1, "exact@sl.test"),
      sdkAlias(2, "duplicate@sl.test"),
      sdkAlias(3, "unbound@sl.test"),
      sdkAlias(4, "provider-only@sl.test"),
      sdkAlias(5, "changed@sl.test"),
      sdkAlias(6, "conflict@sl.test"),
    ];
    const ciphers = [
      login(1, "exact@sl.test", 1),
      login(2, "duplicate@sl.test"),
      login(3, "duplicate@sl.test"),
      login(4, "unbound@sl.test"),
      login(5, "old-address@sl.test", 5),
      login(6, "conflict@sl.test", 999),
      login(7, "gone@sl.test", 404),
      login(8, "person@example.test"),
    ];

    const cipherService = mock<CipherService>();
    cipherService.getAllDecrypted.mockResolvedValue(ciphers);
    const report = await new AliasReconciliationService(
      serviceWithAliases(aliases),
      cipherService,
    ).reconcile(userId, false);

    expect(report.exactMatches[0]).toMatchObject({
      cipherId: cipherId(1),
      alias: { aliasId: "1" },
    });
    expect(report.duplicates[0]).toMatchObject({ alias: { aliasId: "2" } });
    expect(report.unbound[0]).toMatchObject({ cipherId: cipherId(4), alias: { aliasId: "3" } });
    expect(report.conflicts).toEqual([expect.objectContaining({ cipherId: cipherId(5) })]);
    expect(report.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ alias: expect.objectContaining({ aliasId: "4" }) }),
        expect.objectContaining({ alias: expect.objectContaining({ aliasId: "6" }) }),
        expect.objectContaining({ cipherId: cipherId(6) }),
        expect.objectContaining({ cipherId: cipherId(7) }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("provider-secret-must-not-enter-report");
  });

  it("keeps a canonical dry run non-mutating", async () => {
    const aliasService = serviceWithAliases([sdkAlias(3, "unbound@sl.test")]);
    const cipherService = mock<CipherService>();
    const cipher = login(1, "unbound@sl.test");
    cipherService.getAllDecrypted.mockResolvedValue([cipher]);

    const report = await new AliasReconciliationService(aliasService, cipherService).reconcile(
      userId,
      false,
    );

    expect(report.summary).toMatchObject({ plannedChanges: 1, appliedChanges: 0, unbound: 1 });
    expect(cipher.aliasBinding).toBeUndefined();
    expect(cipherService.updateWithServer).not.toHaveBeenCalled();
  });

  it("applies the SDK plan through normal vault persistence and is idempotent", async () => {
    const aliasService = serviceWithAliases([sdkAlias(3, "unbound@sl.test")]);
    const cipherService = mock<CipherService>();
    let stored = [login(1, "unbound@sl.test")];
    cipherService.getAllDecrypted.mockImplementation(async () => stored);
    cipherService.updateWithServer.mockImplementation(async (view) => {
      stored = [view];
      return view;
    });
    const service = new AliasReconciliationService(aliasService, cipherService);

    const applied = await service.reconcile(userId, true);
    const rerun = await service.reconcile(userId, true);

    expect(applied.summary).toMatchObject({ plannedChanges: 1, appliedChanges: 1 });
    expect(stored[0].aliasBinding).toMatchObject({ aliasId: "3", connectionId });
    expect(rerun.summary).toMatchObject({ plannedChanges: 0, appliedChanges: 0, exactMatches: 1 });
    expect(cipherService.updateWithServer).toHaveBeenCalledTimes(1);
  });

  it("dry-runs and applies an SDK v1 reference migration through the SDK", async () => {
    const aliasService = serviceWithAliases([sdkAlias(3, "legacy@sl.test")]);
    const cipherService = mock<CipherService>();
    const cipher = login(1, "legacy@sl.test");
    const legacy = new FieldView();
    legacy.name = ALIAS_BINDING_FIELD_NAME;
    legacy.type = FieldType.Hidden;
    legacy.value = JSON.stringify({
      version: 1,
      provider: "simplelogin",
      providerInstance: provider.instance,
      aliasId: 3,
      address: "legacy@sl.test",
    });
    cipher.fields = [legacy];
    hydrateAliasBinding(cipher);
    cipherService.getAllDecrypted.mockResolvedValue([cipher]);
    let persisted: CipherView | undefined;
    cipherService.updateWithServer.mockImplementation(async (view) => {
      persisted = view;
      return view;
    });
    const service = new AliasReconciliationService(aliasService, cipherService);

    const dryRun = await service.reconcile(userId, false);
    const applied = await service.reconcile(userId, true);

    expect(dryRun.summary).toMatchObject({ plannedChanges: 1, appliedChanges: 0 });
    expect(applied.summary).toMatchObject({ plannedChanges: 1, appliedChanges: 1 });
    expect(persisted?.aliasBinding).toMatchObject({ aliasId: "3", connectionId });
    expect(persisted?.fields).toEqual([]);
  });

  it("reports an SDK v1 migration when its provider alias is already missing", async () => {
    const cipherService = mock<CipherService>();
    const cipher = login(1, "missing-legacy@sl.test");
    const legacy = new FieldView();
    legacy.name = ALIAS_BINDING_FIELD_NAME;
    legacy.type = FieldType.Hidden;
    legacy.value = JSON.stringify({
      version: 1,
      provider: "simplelogin",
      providerInstance: provider.instance,
      aliasId: 404,
      address: "missing-legacy@sl.test",
    });
    cipher.fields = [legacy];
    hydrateAliasBinding(cipher);
    cipherService.getAllDecrypted.mockResolvedValue([cipher]);
    let persisted: CipherView | undefined;
    cipherService.updateWithServer.mockImplementation(async (view) => {
      persisted = view;
      return view;
    });

    const report = await new AliasReconciliationService(
      serviceWithAliases([]),
      cipherService,
    ).reconcile(userId, true);

    expect(report.summary).toMatchObject({ plannedChanges: 1, appliedChanges: 1 });
    expect(report.changes).toEqual([
      expect.objectContaining({
        status: "applied",
        alias: expect.objectContaining({ aliasId: "404", connectionId }),
      }),
    ]);
    expect(persisted?.aliasBinding).toMatchObject({ aliasId: "404", connectionId });
  });

  it("keeps failed vault writes unbound without exposing the failure", async () => {
    const aliasService = serviceWithAliases([sdkAlias(1, "failed@sl.test")]);
    const cipherService = mock<CipherService>();
    cipherService.getAllDecrypted.mockResolvedValue([login(1, "failed@sl.test")]);
    cipherService.updateWithServer.mockRejectedValue(
      new Error("provider-token-should-not-be-reported"),
    );

    const report = await new AliasReconciliationService(aliasService, cipherService).reconcile(
      userId,
      true,
    );

    expect(report.summary).toMatchObject({ appliedChanges: 0, failedChanges: 1, unbound: 1 });
    expect(JSON.stringify(report)).not.toContain("provider-token-should-not-be-reported");
  });

  it("plans 1,001 address pairs through the SDK without conflicts", async () => {
    const aliases = Array.from({ length: 1_001 }, (_, index) =>
      sdkAlias(index + 1, `alias-${index}@sl.test`),
    );
    const ciphers = aliases.map((item, index) => login(index + 1, item.email as string));
    const cipherService = mock<CipherService>();
    cipherService.getAllDecrypted.mockResolvedValue(ciphers);

    const report = await new AliasReconciliationService(
      serviceWithAliases(aliases),
      cipherService,
    ).reconcile(userId, false);

    expect(report.unbound).toHaveLength(1_001);
    expect(report.duplicates).toHaveLength(0);
    expect(report.conflicts).toHaveLength(0);
  });

  it("honors provider rate limiting while paging", async () => {
    const aliasService = mock<SimpleLoginAliasService>();
    const cipherService = mock<CipherService>();
    const waitForRetry = jest.fn().mockResolvedValue(undefined);
    aliasService.providerIdentity.mockReturnValue(provider);
    aliasService.listCanonical
      .mockRejectedValueOnce(new SimpleLoginAliasError("limited", "rate-limited", 429, 7))
      .mockResolvedValueOnce({ aliases: [], page: 0 });
    cipherService.getAllDecrypted.mockResolvedValue([]);

    const report = await new AliasReconciliationService(
      aliasService,
      cipherService,
      waitForRetry,
    ).reconcile(userId, false);

    expect(report.summary.aliasesScanned).toBe(0);
    expect(aliasService.listCanonical).toHaveBeenCalledTimes(2);
    expect(waitForRetry).toHaveBeenCalledWith(7_000);
  });
});
