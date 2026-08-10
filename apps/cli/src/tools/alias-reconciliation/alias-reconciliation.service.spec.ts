import { mock } from "jest-mock-extended";

import { EMAIL_ALIAS_IDENTITY_VERSION } from "@bitwarden/common/tools/alias";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import {
  SimpleLoginAlias,
  SimpleLoginAliasError,
  SimpleLoginAliasService,
} from "@bitwarden/generator-core";

import {
  AliasReconciliationService,
  analyzeAliasReconciliation,
} from "./alias-reconciliation.service";

const userId = "user-id" as UserId;

function alias(id: number, address: string): SimpleLoginAlias {
  return {
    id,
    address,
    name: "migration fixture",
    note: "provider-secret-must-not-enter-report",
    enabled: true,
    pinned: false,
    createdAt: 1,
    blockedCount: 0,
    forwardedCount: 0,
    repliedCount: 0,
    supportsPgp: false,
    pgpDisabled: false,
    mailboxes: [],
    latestActivity: null,
  };
}

function login(id: string, username: string, aliasId?: number): CipherView {
  const cipher = new CipherView();
  cipher.id = id as any;
  cipher.type = CipherType.Login;
  cipher.login.username = username;
  if (aliasId !== undefined) {
    cipher.aliasBinding = {
      version: EMAIL_ALIAS_IDENTITY_VERSION,
      provider: "simplelogin",
      id: aliasId.toString(),
      address: username,
    };
  }
  return cipher;
}

describe("alias reconciliation", () => {
  it("detects exact, duplicate, conflict, missing and unbound records deterministically", () => {
    const aliases = [
      alias(1, "exact@sl.test"),
      alias(2, "duplicate@sl.test"),
      alias(3, "unbound@sl.test"),
      alias(4, "provider-only@sl.test"),
      alias(5, "changed@sl.test"),
      alias(6, "conflict@sl.test"),
    ];
    const ciphers = [
      login("exact", "EXACT@sl.test", 1),
      login("duplicate-a", "duplicate@sl.test"),
      login("duplicate-b", "duplicate@sl.test"),
      login("unbound", "unbound@sl.test"),
      login("changed", "old-address@sl.test", 5),
      login("conflict", "conflict@sl.test", 999),
      login("provider-missing", "gone@sl.test", 404),
      login("ordinary", "person@example.test"),
    ];

    const report = analyzeAliasReconciliation(aliases, ciphers);

    expect(report.exactMatches).toEqual([
      expect.objectContaining({ cipherId: "exact", alias: expect.objectContaining({ id: "1" }) }),
    ]);
    expect(report.duplicates).toEqual([
      expect.objectContaining({
        alias: expect.objectContaining({ id: "2" }),
        ciphers: [
          expect.objectContaining({ cipherId: "duplicate-a" }),
          expect.objectContaining({ cipherId: "duplicate-b" }),
        ],
      }),
    ]);
    expect(report.unbound).toEqual([
      expect.objectContaining({ cipherId: "unbound", alias: expect.objectContaining({ id: "3" }) }),
    ]);
    expect(report.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cipherId: "changed", reason: "binding-does-not-match-provider" }),
        expect.objectContaining({ cipherId: "conflict", reason: "binding-does-not-match-provider" }),
      ]),
    );
    expect(report.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "provider-alias-without-login",
          alias: expect.objectContaining({ id: "4" }),
        }),
        expect.objectContaining({
          kind: "bound-login-without-provider-alias",
          cipherId: "provider-missing",
        }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("provider-secret-must-not-enter-report");
  });

  it("does not make a dry run mutate the vault", async () => {
    const aliasService = mock<SimpleLoginAliasService>();
    const cipherService = mock<CipherService>();
    const cipher = login("unbound", "unbound@sl.test");
    aliasService.list.mockResolvedValue({ items: [alias(3, "unbound@sl.test")], page: 0 });
    cipherService.getAllDecrypted.mockResolvedValue([cipher]);
    const service = new AliasReconciliationService(aliasService, cipherService);

    const report = await service.reconcile(userId, false);

    expect(report.mode).toBe("dry-run");
    expect(report.summary).toMatchObject({ plannedChanges: 1, appliedChanges: 0, unbound: 1 });
    expect(cipher.aliasBinding).toBeUndefined();
    expect(cipherService.updateWithServer).not.toHaveBeenCalled();
  });

  it("applies only safe matches and is idempotent", async () => {
    const aliasService = mock<SimpleLoginAliasService>();
    const cipherService = mock<CipherService>();
    const cipher = login("unbound", "unbound@sl.test");
    aliasService.list.mockResolvedValue({ items: [alias(3, "unbound@sl.test")], page: 0 });
    cipherService.getAllDecrypted.mockResolvedValue([cipher]);
    cipherService.updateWithServer.mockImplementation(async (view) => view);
    const service = new AliasReconciliationService(aliasService, cipherService);

    const applied = await service.reconcile(userId, true);
    const rerun = await service.reconcile(userId, true);

    expect(applied.summary).toMatchObject({
      plannedChanges: 1,
      appliedChanges: 1,
      failedChanges: 0,
      exactMatches: 1,
      unbound: 0,
    });
    expect(applied.changes).toEqual([
      expect.objectContaining({ cipherId: "unbound", status: "applied" }),
    ]);
    expect(rerun.summary).toMatchObject({
      plannedChanges: 0,
      appliedChanges: 0,
      exactMatches: 1,
      unbound: 0,
    });
    expect(cipherService.updateWithServer).toHaveBeenCalledTimes(1);
  });

  it("continues safely when an individual vault update fails", async () => {
    const aliasService = mock<SimpleLoginAliasService>();
    const cipherService = mock<CipherService>();
    const failed = login("failed", "failed@sl.test");
    const applied = login("applied", "applied@sl.test");
    aliasService.list.mockResolvedValue({
      items: [alias(1, "failed@sl.test"), alias(2, "applied@sl.test")],
      page: 0,
    });
    cipherService.getAllDecrypted.mockResolvedValue([failed, applied]);
    cipherService.updateWithServer.mockImplementation(async (view) => {
      if (view.id === "failed") {
        throw new Error("provider-token-should-not-be-reported");
      }
      return view;
    });
    const service = new AliasReconciliationService(aliasService, cipherService);

    const report = await service.reconcile(userId, true);

    expect(report.summary).toMatchObject({ appliedChanges: 1, failedChanges: 1, unbound: 1 });
    expect(report.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cipherId: "failed", status: "failed" }),
        expect.objectContaining({ cipherId: "applied", status: "applied" }),
      ]),
    );
    expect(failed.aliasBinding).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("provider-token-should-not-be-reported");
  });

  it("handles 1,001 exact address pairs in linear report-sized output", () => {
    const aliases = Array.from({ length: 1_001 }, (_, index) =>
      alias(index + 1, `alias-${index}@sl.test`),
    );
    const ciphers = aliases.map((item) => login(`cipher-${item.id}`, item.address));

    const report = analyzeAliasReconciliation(aliases, ciphers);

    expect(report.unbound).toHaveLength(1_001);
    expect(report.duplicates).toHaveLength(0);
    expect(report.conflicts).toHaveLength(0);
  });

  it("honors provider rate limiting while paginating a large vault", async () => {
    const aliasService = mock<SimpleLoginAliasService>();
    const cipherService = mock<CipherService>();
    const waitForRetry = jest.fn().mockResolvedValue(undefined);
    aliasService.list
      .mockRejectedValueOnce(new SimpleLoginAliasError("limited", "rate-limited", 429, 7))
      .mockResolvedValueOnce({ items: [], page: 0 });
    cipherService.getAllDecrypted.mockResolvedValue([]);
    const service = new AliasReconciliationService(aliasService, cipherService, waitForRetry);

    const report = await service.reconcile(userId, false);

    expect(report.summary.aliasesScanned).toBe(0);
    expect(aliasService.list).toHaveBeenCalledTimes(2);
    expect(waitForRetry).toHaveBeenCalledWith(7_000);
  });

  it("reports every bound duplicate when its provider alias is gone", () => {
    const report = analyzeAliasReconciliation([], [
      login("gone-a", "gone@sl.test", 404),
      login("gone-b", "gone@sl.test", 404),
    ]);

    expect(report.missing).toEqual([
      expect.objectContaining({ cipherId: "gone-a", kind: "bound-login-without-provider-alias" }),
      expect.objectContaining({ cipherId: "gone-b", kind: "bound-login-without-provider-alias" }),
    ]);
  });
});
