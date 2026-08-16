import {
  Alias,
  AliasConnection,
  AliasReconciliationOutcome,
  AliasReconciliationPlan,
  apply_alias_reconciliation,
  plan_alias_reconciliation,
} from "@bitwarden/alias-sdk-internal";
import {
  AliasProjectedReferenceTransaction,
  EmailAliasIdentity,
  emailAliasIdentitiesEqual,
} from "@bitwarden/common/tools/alias";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { SimpleLoginAliasError, SimpleLoginAliasService } from "@bitwarden/generator-core";
import { CipherId } from "@bitwarden/sdk-internal";

export const ALIAS_RECONCILIATION_REPORT_VERSION = 2 as const;

export type AliasReconciliationVault = Pick<CipherService, "getAllDecrypted" | "updateWithServer">;

export type AliasReconciliationIdentity = EmailAliasIdentity;

export type AliasReconciliationCipher = {
  cipherId: string;
  username: string;
};

export type AliasReconciliationMatch = AliasReconciliationCipher & {
  alias: AliasReconciliationIdentity;
};

export type AliasReconciliationDuplicate = {
  alias: AliasReconciliationIdentity;
  ciphers: AliasReconciliationCipher[];
};

export type AliasReconciliationConflictReason =
  "binding-does-not-match-inventory" | "cipher-id-missing" | "sdk-skipped-cipher";

export type AliasReconciliationConflict = AliasReconciliationCipher & {
  reason: AliasReconciliationConflictReason;
  binding?: AliasReconciliationIdentity;
  availableAliases: AliasReconciliationIdentity[];
};

export type AliasReconciliationMissing =
  | {
      kind: "alias-without-login";
      alias: AliasReconciliationIdentity;
    }
  | (AliasReconciliationCipher & {
      kind: "bound-login-without-alias";
      binding: AliasReconciliationIdentity;
    });

export type AliasReconciliationChange = AliasReconciliationMatch & {
  status: "applied" | "failed" | "pending";
  reason?:
    | "vault-update-failed"
    | "vault-update-outcome-unknown"
    | "reference-prepare-failed"
    | "reference-abort-pending"
    | "reference-commit-pending"
    | "reference-recovery-pending";
};

export interface AliasReferenceTransactionJournal {
  prepareReference(
    cipherId: string,
    expected: EmailAliasIdentity | undefined,
    alias: EmailAliasIdentity,
  ): Promise<string | undefined>;
  commitReference(transactionId: string): Promise<void>;
  abortReference(transactionId: string): Promise<void>;
  pendingReferenceTransactions(): Promise<AliasProjectedReferenceTransaction[]>;
}

export type AliasReconciliationAnalysis = {
  exactMatches: AliasReconciliationMatch[];
  duplicates: AliasReconciliationDuplicate[];
  conflicts: AliasReconciliationConflict[];
  missing: AliasReconciliationMissing[];
};

export type AliasReconciliationReport = AliasReconciliationAnalysis & {
  object: "aliasReconciliation";
  version: typeof ALIAS_RECONCILIATION_REPORT_VERSION;
  connectionId: string;
  mode: "dry-run" | "apply";
  summary: {
    aliasesScanned: number;
    loginCiphersScanned: number;
    exactMatches: number;
    duplicates: number;
    conflicts: number;
    missing: number;
    plannedChanges: number;
    appliedChanges: number;
    failedChanges: number;
    pendingChanges: number;
    recoveredReferenceTransactions: number;
    pendingReferenceTransactions: number;
  };
  changes: AliasReconciliationChange[];
};

function cipherReference(cipher: CipherView): AliasReconciliationCipher {
  return {
    cipherId: cipher.id ?? "",
    username: cipher.login?.username ?? "",
  };
}

function sortByAddressAndId<T extends { address: string; aliasId: string }>(
  left: T,
  right: T,
): number {
  return left.address.localeCompare(right.address) || left.aliasId.localeCompare(right.aliasId);
}

function sortMatches(left: AliasReconciliationMatch, right: AliasReconciliationMatch): number {
  return (
    left.alias.address.localeCompare(right.alias.address) ||
    left.alias.aliasId.localeCompare(right.alias.aliasId) ||
    left.cipherId.localeCompare(right.cipherId)
  );
}

type Wait = (milliseconds: number) => Promise<void>;

const wait: Wait = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

async function listAliasPageWithRetry(
  aliasService: SimpleLoginAliasService,
  page: number,
  waitForRetry: Wait,
) {
  return withRateLimitRetry(() => aliasService.listCanonical(page), waitForRetry);
}

async function withRateLimitRetry<Result>(
  operation: () => Promise<Result>,
  waitForRetry: Wait,
): Promise<Result> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof SimpleLoginAliasError) ||
        error.code !== "rate-limited" ||
        attempt >= 2
      ) {
        throw error;
      }
      const retryAfterSeconds = Math.min(300, Math.max(1, error.retryAfterSeconds ?? 60));
      await waitForRetry(retryAfterSeconds * 1_000);
    }
  }
}

async function listAllAliases(
  aliasService: SimpleLoginAliasService,
  waitForRetry: Wait,
): Promise<Alias[]> {
  const aliases = new Map<string, Alias>();
  let page = 0;
  const seenPages = new Set<number>();

  while (!seenPages.has(page)) {
    seenPages.add(page);
    const result = await listAliasPageWithRetry(aliasService, page, waitForRetry);
    for (const alias of result.aliases) {
      const id = alias.identity.aliasId;
      const existing = aliases.get(id);
      // A live paginated inventory can overlap at a page boundary.
      if (existing && !emailAliasIdentitiesEqual(existing.identity, alias.identity)) {
        throw new SimpleLoginAliasError(
          "The alias adapter returned conflicting records",
          "invalid-response",
        );
      }
      aliases.set(id, alias);
    }
    if (result.aliases.length < 20) {
      break;
    }
    page += 1;
  }

  return [...aliases.values()];
}

function isConfiguredConnectionBinding(
  binding: EmailAliasIdentity,
  connection: AliasConnection,
): boolean {
  return binding.connectionId === connection.connectionId;
}

async function recoverOmittedBoundAliases(
  aliasService: SimpleLoginAliasService,
  aliases: Alias[],
  ciphers: CipherView[],
  connection: AliasConnection,
  waitForRetry: Wait,
): Promise<Alias[]> {
  const aliasesById = new Map(aliases.map((alias) => [alias.identity.aliasId, alias]));
  const boundIds = new Set(
    ciphers
      .map((cipher) => cipher.aliasBinding)
      .filter(
        (binding): binding is EmailAliasIdentity =>
          binding !== undefined && isConfiguredConnectionBinding(binding, connection),
      )
      .map((binding) => binding.aliasId),
  );

  for (const boundId of boundIds) {
    if (aliasesById.has(boundId)) {
      continue;
    }

    let alias: Alias;
    try {
      alias = await withRateLimitRetry(() => aliasService.getCanonical(boundId), waitForRetry);
    } catch (error) {
      if (error instanceof SimpleLoginAliasError && error.code === "not-found") {
        continue;
      }
      throw error;
    }
    if (alias.identity.aliasId !== boundId) {
      throw new SimpleLoginAliasError(
        "The alias adapter returned an unexpected record",
        "invalid-response",
      );
    }
    aliasesById.set(boundId, alias);
  }

  return [...aliasesById.values()];
}

function cipherIdString(cipherId: CipherId): string {
  return cipherId as unknown as string;
}

function analysisFromSdkPlan(
  plan: AliasReconciliationPlan,
  aliases: Alias[],
  ciphers: CipherView[],
): AliasReconciliationAnalysis {
  const aliasesById = new Map(aliases.map((alias) => [alias.identity.aliasId, alias.identity]));
  const ciphersById = new Map(ciphers.map((cipher) => [cipher.id ?? "", cipher]));
  const result: AliasReconciliationAnalysis = {
    exactMatches: [],
    duplicates: [],
    conflicts: [],
    missing: [],
  };

  const match = (aliasId: string, cipherId: CipherId): AliasReconciliationMatch | undefined => {
    const alias = aliasesById.get(aliasId);
    const cipher = ciphersById.get(cipherIdString(cipherId));
    return alias && cipher ? { ...cipherReference(cipher), alias } : undefined;
  };

  for (const outcome of plan.outcomes as AliasReconciliationOutcome[]) {
    switch (outcome.status) {
      case "matched": {
        const matched = match(outcome.alias_id, outcome.cipher_id);
        if (matched) {
          result.exactMatches.push(matched);
        }
        break;
      }
      case "staleBinding": {
        const matched = match(outcome.alias_id, outcome.cipher_id);
        const cipher = ciphersById.get(cipherIdString(outcome.cipher_id));
        if (matched && cipher) {
          result.conflicts.push({
            ...cipherReference(cipher),
            reason: "binding-does-not-match-inventory",
            binding: cipher.aliasBinding,
            availableAliases: [matched.alias],
          });
        }
        break;
      }
      case "duplicateBinding": {
        const alias = aliasesById.get(outcome.alias_id);
        if (alias) {
          result.duplicates.push({
            alias,
            ciphers: outcome.cipher_ids
              .map((id) => ciphersById.get(cipherIdString(id)))
              .filter((cipher): cipher is CipherView => cipher !== undefined)
              .map(cipherReference),
          });
        }
        break;
      }
      case "missingAlias": {
        const cipher = ciphersById.get(cipherIdString(outcome.cipher_id));
        if (cipher?.aliasBinding) {
          result.missing.push({
            ...cipherReference(cipher),
            kind: "bound-login-without-alias",
            binding: cipher.aliasBinding,
          });
        }
        break;
      }
      case "unboundAlias": {
        const alias = aliasesById.get(outcome.alias_id);
        if (alias) {
          result.missing.push({ kind: "alias-without-login", alias });
        }
        break;
      }
      case "skippedCipher": {
        const cipher = outcome.cipher_id
          ? ciphersById.get(cipherIdString(outcome.cipher_id))
          : undefined;
        result.conflicts.push({
          cipherId: cipher?.id ?? "",
          username: cipher?.login?.username ?? "",
          reason: "sdk-skipped-cipher",
          binding: cipher?.aliasBinding,
          availableAliases: [],
        });
        break;
      }
    }
  }

  result.exactMatches.sort(sortMatches);
  result.duplicates.sort((left, right) => sortByAddressAndId(left.alias, right.alias));
  result.conflicts.sort((left, right) => left.cipherId.localeCompare(right.cipherId));
  result.missing.sort((left, right) => {
    const leftAddress = left.kind === "alias-without-login" ? left.alias.address : left.username;
    const rightAddress =
      right.kind === "alias-without-login" ? right.alias.address : right.username;
    return leftAddress.localeCompare(rightAddress);
  });
  return result;
}

export class AliasReconciliationService {
  private readonly referenceJournal: AliasReferenceTransactionJournal;

  constructor(
    private readonly aliasService: SimpleLoginAliasService,
    private readonly cipherService: AliasReconciliationVault,
    private readonly waitForRetry: Wait = wait,
    referenceJournal?: AliasReferenceTransactionJournal,
  ) {
    this.referenceJournal = referenceJournal ?? aliasService;
  }

  private async recoverReferenceTransactions(
    ciphers: CipherView[],
    apply: boolean,
  ): Promise<{
    recovered: number;
    pending: AliasProjectedReferenceTransaction[];
  }> {
    const initial = (await this.referenceJournal.pendingReferenceTransactions()) ?? [];
    if (!apply || initial.length === 0) {
      return { recovered: 0, pending: initial };
    }
    const ciphersById = new Map(ciphers.map((cipher) => [cipher.id ?? "", cipher]));
    for (const transaction of initial) {
      const current = ciphersById.get(transaction.cipherId)?.aliasBinding;
      try {
        if (current && emailAliasIdentitiesEqual(current, transaction.alias)) {
          await this.referenceJournal.commitReference(transaction.transactionId);
        } else if (
          (current === undefined && transaction.expectedAlias === null) ||
          (current !== undefined &&
            transaction.expectedAlias !== null &&
            emailAliasIdentitiesEqual(current, transaction.expectedAlias))
        ) {
          await this.referenceJournal.abortReference(transaction.transactionId);
        }
      } catch {
        // A store can report failure after a durable write. Reload below decides whether recovery
        // actually remains pending without exposing store/provider details.
      }
    }
    const pending = (await this.referenceJournal.pendingReferenceTransactions()) ?? [];
    return { recovered: initial.length - pending.length, pending };
  }

  async reconcile(userId: UserId, apply: boolean): Promise<AliasReconciliationReport> {
    const ciphers = await this.cipherService.getAllDecrypted(userId);
    const loginCiphers = ciphers.filter((cipher) => cipher.type === CipherType.Login);
    const transactionRecovery = await this.recoverReferenceTransactions(loginCiphers, apply);
    let pendingTransactions = transactionRecovery.pending;
    const connection = this.aliasService.providerIdentity();
    const listedAliases = await listAllAliases(this.aliasService, this.waitForRetry);
    const aliases = await recoverOmittedBoundAliases(
      this.aliasService,
      listedAliases,
      loginCiphers,
      connection,
      this.waitForRetry,
    );
    const sdkCiphers = loginCiphers
      .filter((cipher) => cipher.aliasBinding !== undefined)
      .map((cipher) => cipher.toSdkCipherView());
    const beforePlan = plan_alias_reconciliation(connection.connectionId, aliases, sdkCiphers);
    const plannedChangeIds = new Set(
      beforePlan.actions.map((action) => cipherIdString(action.cipher_id)),
    );
    let finalPlan = beforePlan;
    const changes: AliasReconciliationChange[] = [];

    if (apply) {
      const output = apply_alias_reconciliation(beforePlan, aliases, sdkCiphers);
      const originalById = new Map(
        sdkCiphers
          .filter((cipher) => cipher.id !== undefined)
          .map((cipher) => [cipherIdString(cipher.id!), cipher]),
      );
      const finalSdkCiphers = [...output.ciphers];
      const updatedById = new Map(
        output.ciphers
          .filter((cipher) => cipher.id !== undefined)
          .map((cipher) => [cipherIdString(cipher.id!), cipher]),
      );
      const actionByCipherId = new Map(
        beforePlan.actions.map((action) => [cipherIdString(action.cipher_id), action]),
      );
      const changedIds = new Set(output.result.changedCipherIds.map(cipherIdString));

      for (const cipherId of changedIds) {
        const sdkCipher = updatedById.get(cipherId);
        const view = sdkCipher ? CipherView.fromSdkCipherView(sdkCipher) : undefined;
        const action = actionByCipherId.get(cipherId);
        const aliasId = action?.alias_id ?? view?.aliasBinding?.aliasId;
        const alias = aliases.find((candidate) => candidate.identity.aliasId === aliasId);
        const changeIdentity = alias?.identity ?? view?.aliasBinding;
        const change =
          changeIdentity && view
            ? {
                ...cipherReference(view),
                alias: changeIdentity,
              }
            : undefined;
        const recoveryPending = pendingTransactions.some(
          (transaction) => transaction.cipherId === cipherId,
        );
        if (recoveryPending) {
          const original = originalById.get(cipherId);
          const outputIndex = finalSdkCiphers.findIndex((cipher) => cipher.id === sdkCipher?.id);
          if (original && outputIndex >= 0) {
            finalSdkCiphers[outputIndex] = original;
          }
          if (change) {
            changes.push({ ...change, status: "pending", reason: "reference-recovery-pending" });
          }
          continue;
        }

        const expected = ciphers.find((cipher) => cipher.id === cipherId)?.aliasBinding;
        let transactionId: string | undefined;
        try {
          if (!view) {
            throw new Error("SDK reconciliation did not return an updated cipher");
          }
          if (changeIdentity) {
            transactionId = await this.referenceJournal.prepareReference(
              cipherId,
              expected,
              changeIdentity,
            );
          }
        } catch {
          const original = originalById.get(cipherId);
          const outputIndex = finalSdkCiphers.findIndex((cipher) => cipher.id === sdkCipher?.id);
          if (original && outputIndex >= 0) {
            finalSdkCiphers[outputIndex] = original;
          }
          const matching = (
            (await this.referenceJournal.pendingReferenceTransactions()) ?? []
          ).filter(
            (transaction) =>
              transaction.cipherId === cipherId &&
              ((transaction.expectedAlias === null && expected === undefined) ||
                (transaction.expectedAlias !== null &&
                  expected !== undefined &&
                  emailAliasIdentitiesEqual(transaction.expectedAlias, expected))) &&
              changeIdentity !== undefined &&
              emailAliasIdentitiesEqual(transaction.alias, changeIdentity),
          );
          for (const transaction of matching) {
            try {
              await this.referenceJournal.abortReference(transaction.transactionId);
            } catch {
              // Reloaded below; an abort may have become durable despite a transport error.
            }
          }
          pendingTransactions = (await this.referenceJournal.pendingReferenceTransactions()) ?? [];
          if (change) {
            changes.push({
              ...change,
              status: pendingTransactions.some((transaction) => transaction.cipherId === cipherId)
                ? "pending"
                : "failed",
              reason: pendingTransactions.some((transaction) => transaction.cipherId === cipherId)
                ? "reference-abort-pending"
                : "reference-prepare-failed",
            });
          }
          continue;
        }

        try {
          await this.cipherService.updateWithServer(view, userId);
        } catch {
          pendingTransactions = (await this.referenceJournal.pendingReferenceTransactions()) ?? [];
          const vaultOutcomePending =
            transactionId !== undefined &&
            pendingTransactions.some((transaction) => transaction.transactionId === transactionId);
          const original = originalById.get(cipherId);
          const outputIndex = finalSdkCiphers.findIndex((cipher) => cipher.id === sdkCipher?.id);
          if (original && outputIndex >= 0) {
            finalSdkCiphers[outputIndex] = original;
          }
          if (change) {
            changes.push({
              ...change,
              status: vaultOutcomePending ? "pending" : "failed",
              reason: vaultOutcomePending ? "vault-update-outcome-unknown" : "vault-update-failed",
            });
          }
          continue;
        }

        if (transactionId) {
          try {
            await this.referenceJournal.commitReference(transactionId);
          } catch {
            const commitPending = (
              (await this.referenceJournal.pendingReferenceTransactions()) ?? []
            ).some((transaction) => transaction.transactionId === transactionId);
            if (commitPending) {
              if (change) {
                changes.push({
                  ...change,
                  status: "pending",
                  reason: "reference-commit-pending",
                });
              }
              continue;
            }
          }
        }
        if (change) {
          changes.push({ ...change, status: "applied" });
        }
      }
      finalPlan = plan_alias_reconciliation(connection.connectionId, aliases, finalSdkCiphers);
    }

    const analysis = analysisFromSdkPlan(finalPlan, aliases, ciphers);
    const appliedChanges = changes.filter((change) => change.status === "applied").length;
    const failedChanges = changes.filter((change) => change.status === "failed").length;
    const pendingChanges = changes.filter((change) => change.status === "pending").length;
    pendingTransactions = (await this.referenceJournal.pendingReferenceTransactions()) ?? [];
    return {
      object: "aliasReconciliation",
      version: ALIAS_RECONCILIATION_REPORT_VERSION,
      connectionId: connection.connectionId,
      mode: apply ? "apply" : "dry-run",
      summary: {
        aliasesScanned: aliases.length,
        loginCiphersScanned: loginCiphers.length,
        exactMatches: analysis.exactMatches.length,
        duplicates: analysis.duplicates.length,
        conflicts: analysis.conflicts.length,
        missing: analysis.missing.length,
        plannedChanges: plannedChangeIds.size,
        appliedChanges,
        failedChanges,
        pendingChanges,
        recoveredReferenceTransactions: transactionRecovery.recovered,
        pendingReferenceTransactions: pendingTransactions.length,
      },
      ...analysis,
      changes,
    };
  }
}
