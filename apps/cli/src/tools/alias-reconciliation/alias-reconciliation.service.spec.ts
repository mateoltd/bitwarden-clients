import { MockProxy, mock } from "jest-mock-extended";

import { Alias, AliasConnection, SensitiveString } from "@bitwarden/alias-sdk-internal";
import {
  AliasSyncDocument,
  AliasSyncStore,
  createAliasSyncDocument,
  projectAliasSync,
} from "@bitwarden/common/tools/alias";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import {
  SimpleLoginAliasError,
  SimpleLoginAliasService,
  createSimpleLoginAliasService,
} from "@bitwarden/generator-core";

import { AliasReconciliationService } from "./alias-reconciliation.service";

const userId = "11111111-1111-4111-8111-111111111111" as UserId;
const connectionId = "22222222-2222-4222-8222-222222222222";
const provider: AliasConnection = {
  version: 1,
  connectionId,
  adapter: {
    adapterId: "test",
    capabilities: {
      create: true,
      list: true,
      get: true,
      enableDisable: true,
      delete: true,
      createSendReplyIdentity: true,
      listSendReplyIdentities: true,
      removeSendReplyIdentity: true,
      extensions: [],
    },
  },
};
const sensitive = (value: string): SensitiveString => value as SensitiveString;
const transactionId = "33333333-3333-4333-8333-333333333333";

function sdkAlias(id: number, address: string): Alias {
  return {
    identity: { version: 1, connectionId, aliasId: String(id), address: sensitive(address) },
    lifecycle: "enabled",
    freshness: "current",
    consistency: "clean",
    label: undefined,
    capabilities: provider.adapter.capabilities,
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
      version: 1,
      connectionId,
      aliasId: aliasId.toString(),
      address: username,
    };
  }
  return cipher;
}

function serviceWithAliases(aliases: Alias[]): MockProxy<SimpleLoginAliasService> {
  const aliasService = mock<SimpleLoginAliasService>();
  aliasService.providerIdentity.mockReturnValue(provider);
  aliasService.listCanonical.mockImplementation(async (page) => ({
    aliases: page === 0 ? aliases : [],
    nextPageToken: undefined,
  }));
  aliasService.getCanonical.mockImplementation(async (id) => {
    const alias = aliases.find((candidate) => candidate.identity.aliasId === id);
    if (!alias) {
      throw new SimpleLoginAliasError("missing", "not-found", 404);
    }
    return alias;
  });
  aliasService.prepareReference.mockResolvedValue(transactionId);
  aliasService.pendingReferenceTransactions.mockResolvedValue([]);
  return aliasService;
}

type SaveFailure = "before" | "after";

function durableReferenceJournal() {
  const state: { document: AliasSyncDocument; failure?: SaveFailure } = {
    document: createAliasSyncDocument("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  };
  const syncStore: AliasSyncStore = {
    load: async () => state.document,
    save: async (document) => {
      const failure = state.failure;
      state.failure = undefined;
      if (failure === "before") {
        throw new Error("journal-save-before-write");
      }
      state.document = document;
      if (failure === "after") {
        throw new Error("journal-save-after-write");
      }
    },
  };
  const createJournal = () =>
    createSimpleLoginAliasService({ token: "provider-secret", connectionId, syncStore });
  return { state, createJournal };
}

describe("alias reconciliation", () => {
  it("uses the SDK to detect exact, duplicate, drifted, and missing current records", async () => {
    const aliases = [
      sdkAlias(1, "exact@sl.test"),
      sdkAlias(2, "duplicate@sl.test"),
      sdkAlias(3, "provider-only@sl.test"),
      sdkAlias(5, "changed@sl.test"),
      sdkAlias(6, "conflict@sl.test"),
    ];
    const ciphers = [
      login(1, "exact@sl.test", 1),
      login(2, "duplicate@sl.test", 2),
      login(3, "duplicate@sl.test", 2),
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

    expect(report).toMatchObject({ object: "aliasReconciliation", version: 2, mode: "dry-run" });
    expect(report.exactMatches[0]).toMatchObject({
      cipherId: cipherId(1),
      alias: { aliasId: "1" },
    });
    expect(report.duplicates[0]).toMatchObject({ alias: { aliasId: "2" } });
    expect(report.conflicts).toEqual([expect.objectContaining({ cipherId: cipherId(5) })]);
    expect(report.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ alias: expect.objectContaining({ aliasId: "3" }) }),
        expect.objectContaining({ alias: expect.objectContaining({ aliasId: "6" }) }),
        expect.objectContaining({ cipherId: cipherId(6) }),
        expect.objectContaining({ cipherId: cipherId(7) }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("provider-secret-must-not-enter-report");
  });

  it("keeps a current-binding refresh dry run non-mutating", async () => {
    const aliasService = serviceWithAliases([sdkAlias(3, "current@sl.test")]);
    const cipherService = mock<CipherService>();
    const cipher = login(1, "stale@sl.test", 3);
    cipherService.getAllDecrypted.mockResolvedValue([cipher]);

    const report = await new AliasReconciliationService(aliasService, cipherService).reconcile(
      userId,
      false,
    );

    expect(report.summary).toMatchObject({ plannedChanges: 1, appliedChanges: 0, conflicts: 1 });
    expect(cipher.aliasBinding).toMatchObject({ aliasId: "3", address: "stale@sl.test" });
    expect(cipher.login.username).toBe("stale@sl.test");
    expect(cipherService.updateWithServer).not.toHaveBeenCalled();
  });

  it("refreshes a current binding through normal vault persistence and is idempotent", async () => {
    const aliasService = serviceWithAliases([sdkAlias(3, "current@sl.test")]);
    const cipherService = mock<CipherService>();
    let stored = [login(1, "stale@sl.test", 3)];
    cipherService.getAllDecrypted.mockImplementation(async () => stored);
    cipherService.updateWithServer.mockImplementation(async (view) => {
      stored = [view];
      return view;
    });
    const service = new AliasReconciliationService(aliasService, cipherService);

    const applied = await service.reconcile(userId, true);
    const rerun = await service.reconcile(userId, true);

    expect(applied.summary).toMatchObject({ plannedChanges: 1, appliedChanges: 1 });
    expect(stored[0].aliasBinding).toMatchObject({
      aliasId: "3",
      connectionId,
      address: "current@sl.test",
    });
    expect(stored[0].login.username).toBe("current@sl.test");
    expect(rerun.summary).toMatchObject({ plannedChanges: 0, appliedChanges: 0, exactMatches: 1 });
    expect(cipherService.updateWithServer).toHaveBeenCalledTimes(1);
    expect(aliasService.prepareReference).toHaveBeenCalledWith(
      cipherId(1),
      expect.objectContaining({ aliasId: "3", address: "stale@sl.test" }),
      expect.objectContaining({ aliasId: "3", address: "current@sl.test" }),
    );
    expect(aliasService.commitReference).toHaveBeenCalledWith(transactionId);
  });

  it("does not infer a binding from an unbound login address", async () => {
    const aliasService = serviceWithAliases([sdkAlias(1, "address-only@sl.test")]);
    const cipherService = mock<CipherService>();
    cipherService.getAllDecrypted.mockResolvedValue([login(1, "address-only@sl.test")]);

    const report = await new AliasReconciliationService(aliasService, cipherService).reconcile(
      userId,
      true,
    );

    expect(report.summary).toMatchObject({ plannedChanges: 0, appliedChanges: 0 });
    expect(report.missing).toEqual([
      expect.objectContaining({
        kind: "alias-without-login",
        alias: expect.objectContaining({ aliasId: "1" }),
      }),
    ]);
    expect(cipherService.updateWithServer).not.toHaveBeenCalled();
  });

  it("keeps a failed current-binding refresh unchanged without exposing the failure", async () => {
    const aliasService = serviceWithAliases([sdkAlias(1, "current@sl.test")]);
    const cipherService = mock<CipherService>();
    cipherService.getAllDecrypted.mockResolvedValue([login(1, "stale@sl.test", 1)]);
    cipherService.updateWithServer.mockRejectedValue(
      new Error("provider-token-should-not-be-reported"),
    );

    const report = await new AliasReconciliationService(aliasService, cipherService).reconcile(
      userId,
      true,
    );

    expect(report.summary).toMatchObject({ appliedChanges: 0, failedChanges: 1, conflicts: 1 });
    expect(JSON.stringify(report)).not.toContain("provider-token-should-not-be-reported");
  });

  it("compensates a journal prepare that reports failure after becoming durable", async () => {
    const aliases = [sdkAlias(1, "current@sl.test")];
    const aliasService = serviceWithAliases(aliases);
    const cipherService = mock<CipherService>();
    cipherService.getAllDecrypted.mockResolvedValue([login(1, "stale@sl.test", 1)]);
    const durable = durableReferenceJournal();
    durable.state.failure = "after";

    const report = await new AliasReconciliationService(
      aliasService,
      cipherService,
      undefined,
      durable.createJournal(),
    ).reconcile(userId, true);

    expect(report.changes).toEqual([
      expect.objectContaining({ status: "failed", reason: "reference-prepare-failed" }),
    ]);
    expect(report.summary.pendingReferenceTransactions).toBe(0);
    expect(Object.values(projectAliasSync(durable.state.document).referenceTransactions)).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "aborted" })]),
    );
    expect(cipherService.updateWithServer).not.toHaveBeenCalled();
  });

  it("leaves no transaction when the initial journal prepare fails before persistence", async () => {
    const aliasService = serviceWithAliases([sdkAlias(1, "current@sl.test")]);
    const cipherService = mock<CipherService>();
    cipherService.getAllDecrypted.mockResolvedValue([login(1, "stale@sl.test", 1)]);
    const durable = durableReferenceJournal();
    durable.state.failure = "before";

    const report = await new AliasReconciliationService(
      aliasService,
      cipherService,
      undefined,
      durable.createJournal(),
    ).reconcile(userId, true);

    expect(report.changes).toEqual([
      expect.objectContaining({ status: "failed", reason: "reference-prepare-failed" }),
    ]);
    expect(projectAliasSync(durable.state.document).referenceTransactions).toEqual({});
    expect(cipherService.updateWithServer).not.toHaveBeenCalled();
  });

  it("keeps an uncertain vault failure pending, then compensates and retries after restart", async () => {
    const aliasService = serviceWithAliases([sdkAlias(1, "current@sl.test")]);
    const cipherService = mock<CipherService>();
    let stored = [login(1, "stale@sl.test", 1)];
    cipherService.getAllDecrypted.mockImplementation(async () => stored);
    const durable = durableReferenceJournal();
    cipherService.updateWithServer.mockRejectedValueOnce(new Error("vault-update-failed"));

    const first = await new AliasReconciliationService(
      aliasService,
      cipherService,
      undefined,
      durable.createJournal(),
    ).reconcile(userId, true);

    expect(first.changes).toEqual([
      expect.objectContaining({ status: "pending", reason: "vault-update-outcome-unknown" }),
    ]);
    expect(first.summary.pendingReferenceTransactions).toBe(1);

    cipherService.updateWithServer.mockImplementation(async (view) => {
      stored = [view];
      return view;
    });
    const restarted = await new AliasReconciliationService(
      aliasService,
      cipherService,
      undefined,
      durable.createJournal(),
    ).reconcile(userId, true);

    expect(restarted.summary).toMatchObject({
      recoveredReferenceTransactions: 1,
      pendingReferenceTransactions: 0,
      appliedChanges: 1,
    });
    expect(Object.values(projectAliasSync(durable.state.document).referenceTransactions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "aborted" }),
        expect.objectContaining({ status: "committed" }),
      ]),
    );
  });

  it("commits after restart when a vault write became durable before reporting failure", async () => {
    const aliasService = serviceWithAliases([sdkAlias(1, "current@sl.test")]);
    const cipherService = mock<CipherService>();
    let stored = [login(1, "stale@sl.test", 1)];
    cipherService.getAllDecrypted.mockImplementation(async () => stored);
    const durable = durableReferenceJournal();
    cipherService.updateWithServer.mockImplementationOnce(async (view) => {
      stored = [view];
      throw new Error("vault-update-after-write");
    });

    const first = await new AliasReconciliationService(
      aliasService,
      cipherService,
      undefined,
      durable.createJournal(),
    ).reconcile(userId, true);

    expect(first.changes).toEqual([
      expect.objectContaining({ status: "pending", reason: "vault-update-outcome-unknown" }),
    ]);
    expect(first.summary.pendingReferenceTransactions).toBe(1);

    const restarted = await new AliasReconciliationService(
      aliasService,
      cipherService,
      undefined,
      durable.createJournal(),
    ).reconcile(userId, true);

    expect(restarted.summary).toMatchObject({
      plannedChanges: 0,
      recoveredReferenceTransactions: 1,
      pendingReferenceTransactions: 0,
    });
    expect(projectAliasSync(durable.state.document).references[cipherId(1)]).toMatchObject({
      alias: expect.objectContaining({ address: "current@sl.test" }),
      conflicted: false,
    });
  });

  it.each(["before", "after"] as const)(
    "recovers an abort that reports failure %s its durable write",
    async (failure) => {
      const aliasService = serviceWithAliases([sdkAlias(1, "current@sl.test")]);
      const cipherService = mock<CipherService>();
      let stored = [login(1, "stale@sl.test", 1)];
      cipherService.getAllDecrypted.mockImplementation(async () => stored);
      cipherService.updateWithServer.mockImplementation(async (view) => {
        stored = [view];
        return view;
      });
      const durable = durableReferenceJournal();
      const journal = durable.createJournal();
      const expected = stored[0].aliasBinding;
      if (!expected) {
        throw new Error("Test cipher is missing its alias binding");
      }
      const prepared = await journal.prepareReference(cipherId(1), expected, {
        ...expected,
        address: "current@sl.test",
      });
      durable.state.failure = failure;

      const first = await new AliasReconciliationService(
        aliasService,
        cipherService,
        undefined,
        durable.createJournal(),
      ).reconcile(userId, true);

      if (failure === "before") {
        expect(first.summary.pendingReferenceTransactions).toBe(1);
        expect(cipherService.updateWithServer).not.toHaveBeenCalled();
        await new AliasReconciliationService(
          aliasService,
          cipherService,
          undefined,
          durable.createJournal(),
        ).reconcile(userId, true);
      } else {
        expect(first.summary).toMatchObject({
          recoveredReferenceTransactions: 1,
          pendingReferenceTransactions: 0,
          appliedChanges: 1,
        });
      }

      expect(
        projectAliasSync(durable.state.document).referenceTransactions[prepared ?? ""],
      ).toMatchObject({ status: "aborted" });
      expect(stored[0].aliasBinding).toMatchObject({ address: "current@sl.test" });
    },
  );

  it("recovers a pending commit after restart when the vault update already succeeded", async () => {
    const aliasService = serviceWithAliases([sdkAlias(1, "current@sl.test")]);
    const cipherService = mock<CipherService>();
    let stored = [login(1, "stale@sl.test", 1)];
    cipherService.getAllDecrypted.mockImplementation(async () => stored);
    const durable = durableReferenceJournal();
    cipherService.updateWithServer.mockImplementation(async (view) => {
      stored = [view];
      durable.state.failure = "before";
      return view;
    });

    const first = await new AliasReconciliationService(
      aliasService,
      cipherService,
      undefined,
      durable.createJournal(),
    ).reconcile(userId, true);

    expect(first.changes).toEqual([
      expect.objectContaining({ status: "pending", reason: "reference-commit-pending" }),
    ]);
    expect(first.summary.pendingReferenceTransactions).toBe(1);

    const restarted = await new AliasReconciliationService(
      aliasService,
      cipherService,
      undefined,
      durable.createJournal(),
    ).reconcile(userId, true);

    expect(restarted.summary).toMatchObject({
      plannedChanges: 0,
      recoveredReferenceTransactions: 1,
      pendingReferenceTransactions: 0,
    });
    expect(projectAliasSync(durable.state.document).references[cipherId(1)]).toMatchObject({
      alias: expect.objectContaining({ address: "current@sl.test" }),
      conflicted: false,
    });
  });

  it("recognizes a commit that became durable before the store reported failure", async () => {
    const aliasService = serviceWithAliases([sdkAlias(1, "current@sl.test")]);
    const cipherService = mock<CipherService>();
    cipherService.getAllDecrypted.mockResolvedValue([login(1, "stale@sl.test", 1)]);
    const durable = durableReferenceJournal();
    cipherService.updateWithServer.mockImplementation(async (view) => {
      durable.state.failure = "after";
      return view;
    });

    const report = await new AliasReconciliationService(
      aliasService,
      cipherService,
      undefined,
      durable.createJournal(),
    ).reconcile(userId, true);

    expect(report.changes).toEqual([expect.objectContaining({ status: "applied" })]);
    expect(report.summary.pendingReferenceTransactions).toBe(0);
    expect(projectAliasSync(durable.state.document).references[cipherId(1)]).toBeDefined();
  });

  it("reconciles 1,001 canonical bindings without manufacturing changes", async () => {
    const aliases = Array.from({ length: 1_001 }, (_, index) =>
      sdkAlias(index + 1, `alias-${index}@sl.test`),
    );
    const ciphers = aliases.map((item, index) =>
      login(index + 1, item.identity.address as string, index + 1),
    );
    const cipherService = mock<CipherService>();
    cipherService.getAllDecrypted.mockResolvedValue(ciphers);

    const report = await new AliasReconciliationService(
      serviceWithAliases(aliases),
      cipherService,
    ).reconcile(userId, true);

    expect(report.summary).toMatchObject({
      loginCiphersScanned: 1_001,
      exactMatches: 1_001,
      plannedChanges: 0,
      appliedChanges: 0,
    });
    expect(cipherService.updateWithServer).not.toHaveBeenCalled();
  });

  it("honors provider rate limiting while paging", async () => {
    const aliasService = mock<SimpleLoginAliasService>();
    const cipherService = mock<CipherService>();
    const waitForRetry = jest.fn().mockResolvedValue(undefined);
    aliasService.providerIdentity.mockReturnValue(provider);
    aliasService.listCanonical
      .mockRejectedValueOnce(new SimpleLoginAliasError("limited", "rate-limited", 429, 7))
      .mockResolvedValueOnce({ aliases: [], nextPageToken: undefined });
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

  it("deduplicates identical overlap from live offset pagination", async () => {
    const aliases = Array.from({ length: 20 }, (_, index) =>
      sdkAlias(index + 1, `alias-${index}@sl.test`),
    );
    const aliasService = mock<SimpleLoginAliasService>();
    const cipherService = mock<CipherService>();
    aliasService.providerIdentity.mockReturnValue(provider);
    aliasService.listCanonical.mockImplementation(async (page) => ({
      aliases: page < 2 ? aliases : [],
      nextPageToken: page < 2 ? `simplelogin-page:${page + 1}` : undefined,
    }));
    cipherService.getAllDecrypted.mockResolvedValue([]);

    const report = await new AliasReconciliationService(aliasService, cipherService).reconcile(
      userId,
      false,
    );

    expect(report.summary.aliasesScanned).toBe(20);
    expect(report.missing).toHaveLength(20);
    expect(aliasService.listCanonical).toHaveBeenCalledTimes(3);
  });

  it("rejects conflicting duplicates from live offset pagination", async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) =>
      sdkAlias(index + 1, `alias-${index}@sl.test`),
    );
    const aliasService = mock<SimpleLoginAliasService>();
    const cipherService = mock<CipherService>();
    aliasService.providerIdentity.mockReturnValue(provider);
    aliasService.listCanonical.mockImplementation(async (page) => ({
      aliases: page === 0 ? firstPage : page === 1 ? [sdkAlias(1, "changed@sl.test")] : [],
      nextPageToken: page < 1 ? `simplelogin-page:${page + 1}` : undefined,
    }));
    cipherService.getAllDecrypted.mockResolvedValue([]);

    await expect(
      new AliasReconciliationService(aliasService, cipherService).reconcile(userId, false),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("recovers an omitted bound alias through the detail endpoint", async () => {
    const listedAliases = Array.from({ length: 20 }, (_, index) =>
      sdkAlias(index + 1, `alias-${index}@sl.test`),
    );
    const recoveredAlias = sdkAlias(21, "recovered@sl.test");
    const aliasService = serviceWithAliases(listedAliases);
    const cipherService = mock<CipherService>();
    const waitForRetry = jest.fn().mockResolvedValue(undefined);
    aliasService.getCanonical
      .mockRejectedValueOnce(new SimpleLoginAliasError("limited", "rate-limited", 429, 4))
      .mockResolvedValueOnce(recoveredAlias);
    cipherService.getAllDecrypted.mockResolvedValue([login(21, "recovered@sl.test", 21)]);

    const report = await new AliasReconciliationService(
      aliasService,
      cipherService,
      waitForRetry,
    ).reconcile(userId, false);

    expect(report.summary).toMatchObject({ aliasesScanned: 21, exactMatches: 1 });
    expect(report.exactMatches[0].alias.aliasId).toBe("21");
    expect(aliasService.getCanonical).toHaveBeenCalledTimes(2);
    expect(aliasService.getCanonical).toHaveBeenCalledWith("21");
    expect(waitForRetry).toHaveBeenCalledWith(4_000);
  });

  it("treats a detail 404 as a genuinely missing bound alias", async () => {
    const aliasService = serviceWithAliases([]);
    const cipherService = mock<CipherService>();
    aliasService.getCanonical.mockRejectedValue(
      new SimpleLoginAliasError("missing", "not-found", 404),
    );
    cipherService.getAllDecrypted.mockResolvedValue([login(22, "missing@sl.test", 22)]);

    const report = await new AliasReconciliationService(aliasService, cipherService).reconcile(
      userId,
      false,
    );

    expect(report.missing).toEqual([
      expect.objectContaining({ kind: "bound-login-without-alias" }),
    ]);
  });

  it("fails conservatively when a bound alias detail cannot be resolved", async () => {
    const aliasService = serviceWithAliases([]);
    const cipherService = mock<CipherService>();
    aliasService.getCanonical.mockRejectedValue(
      new SimpleLoginAliasError("unavailable", "remote-error", 503),
    );
    cipherService.getAllDecrypted.mockResolvedValue([login(23, "unresolved@sl.test", 23)]);

    await expect(
      new AliasReconciliationService(aliasService, cipherService).reconcile(userId, false),
    ).rejects.toMatchObject({ code: "remote-error" });
  });
});
