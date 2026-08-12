import { EmailAliasIdentity } from "@bitwarden/common/tools/alias";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { SimpleLoginAliasError, SimpleLoginAliasService } from "@bitwarden/generator-core";
import {
  Alias,
  AliasProviderIdentity,
  AliasReconciliationOutcome,
  AliasReconciliationPlan,
  CipherId,
  apply_alias_reconciliation,
  create_alias_reference,
  parse_alias_reference,
  plan_alias_reconciliation,
} from "@bitwarden/sdk-internal";

export const ALIAS_RECONCILIATION_REPORT_VERSION = 1 as const;

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
  | "binding-does-not-match-provider"
  | "cipher-id-missing"
  | "provider-address-not-unique"
  | "sdk-skipped-cipher";

export type AliasReconciliationConflict = AliasReconciliationCipher & {
  reason: AliasReconciliationConflictReason;
  binding?: AliasReconciliationIdentity;
  providerAliases: AliasReconciliationIdentity[];
};

export type AliasReconciliationMissing =
  | {
      kind: "provider-alias-without-login";
      alias: AliasReconciliationIdentity;
    }
  | (AliasReconciliationCipher & {
      kind: "bound-login-without-provider-alias";
      binding: AliasReconciliationIdentity;
    });

export type AliasReconciliationChange = AliasReconciliationMatch & {
  status: "applied" | "failed";
  reason?: "vault-update-failed";
};

export type AliasReconciliationAnalysis = {
  exactMatches: AliasReconciliationMatch[];
  duplicates: AliasReconciliationDuplicate[];
  conflicts: AliasReconciliationConflict[];
  missing: AliasReconciliationMissing[];
};

export type AliasReconciliationReport = AliasReconciliationAnalysis & {
  object: "aliasReconciliation";
  version: typeof ALIAS_RECONCILIATION_REPORT_VERSION;
  provider: "simplelogin";
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
      const id = alias.id.toString();
      const existing = aliases.get(id);
      // SimpleLogin uses live offset pagination, so a record can overlap at a page boundary.
      if (existing && existing.email !== alias.email) {
        throw new SimpleLoginAliasError(
          `SimpleLogin returned conflicting records for alias ${id}`,
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

function isConfiguredProviderBinding(
  binding: EmailAliasIdentity,
  provider: AliasProviderIdentity,
): boolean {
  return (
    binding.provider === provider.provider &&
    binding.providerInstance === provider.instance &&
    binding.connectionId === provider.connectionId
  );
}

async function recoverOmittedBoundAliases(
  aliasService: SimpleLoginAliasService,
  aliases: Alias[],
  ciphers: CipherView[],
  provider: AliasProviderIdentity,
  waitForRetry: Wait,
): Promise<Alias[]> {
  const aliasesById = new Map(aliases.map((alias) => [alias.id.toString(), alias]));
  const boundIds = new Set(
    ciphers
      .map((cipher) => cipher.aliasBinding)
      .filter(
        (binding): binding is EmailAliasIdentity =>
          binding !== undefined && isConfiguredProviderBinding(binding, provider),
      )
      .map((binding) => binding.aliasId),
  );

  for (const boundId of boundIds) {
    if (aliasesById.has(boundId)) {
      continue;
    }

    let alias: Alias;
    try {
      alias = await withRateLimitRetry(
        () => aliasService.getCanonical(BigInt(boundId)),
        waitForRetry,
      );
    } catch (error) {
      if (error instanceof SimpleLoginAliasError && error.code === "not-found") {
        continue;
      }
      throw error;
    }
    if (alias.id.toString() !== boundId) {
      throw new SimpleLoginAliasError(
        `SimpleLogin returned an unexpected record for alias ${boundId}`,
        "invalid-response",
      );
    }
    aliasesById.set(boundId, alias);
  }

  return [...aliasesById.values()];
}

function canonicalIdentity(
  provider: AliasProviderIdentity,
  alias: Alias,
): AliasReconciliationIdentity {
  const reference = parse_alias_reference(create_alias_reference(provider, alias));
  return {
    version: 2,
    provider: reference.provider,
    providerInstance: reference.providerInstance,
    connectionId: reference.connectionId,
    aliasId: reference.aliasId.toString(),
    address: reference.address as string,
  };
}

function cipherIdString(cipherId: CipherId): string {
  return cipherId as unknown as string;
}

function analysisFromSdkPlan(
  plan: AliasReconciliationPlan,
  aliases: Alias[],
  ciphers: CipherView[],
): AliasReconciliationAnalysis {
  const aliasesById = new Map(
    aliases.map((alias) => [alias.id.toString(), canonicalIdentity(plan.provider, alias)]),
  );
  const ciphersById = new Map(ciphers.map((cipher) => [cipher.id ?? "", cipher]));
  const result: AliasReconciliationAnalysis = {
    exactMatches: [],
    duplicates: [],
    conflicts: [],
    missing: [],
  };

  const match = (aliasId: bigint, cipherId: CipherId): AliasReconciliationMatch | undefined => {
    const alias = aliasesById.get(aliasId.toString());
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
            reason: "binding-does-not-match-provider",
            binding: cipher.aliasBinding,
            providerAliases: [matched.alias],
          });
        }
        break;
      }
      case "duplicateBinding": {
        const alias = aliasesById.get(outcome.alias_id.toString());
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
            kind: "bound-login-without-provider-alias",
            binding: cipher.aliasBinding,
          });
        }
        break;
      }
      case "unboundAlias": {
        const alias = aliasesById.get(outcome.alias_id.toString());
        if (alias) {
          result.missing.push({ kind: "provider-alias-without-login", alias });
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
          providerAliases: [],
        });
        break;
      }
    }
  }

  result.exactMatches.sort(sortMatches);
  result.duplicates.sort((left, right) => sortByAddressAndId(left.alias, right.alias));
  result.conflicts.sort((left, right) => left.cipherId.localeCompare(right.cipherId));
  result.missing.sort((left, right) => {
    const leftAddress =
      left.kind === "provider-alias-without-login" ? left.alias.address : left.username;
    const rightAddress =
      right.kind === "provider-alias-without-login" ? right.alias.address : right.username;
    return leftAddress.localeCompare(rightAddress);
  });
  return result;
}

export class AliasReconciliationService {
  constructor(
    private readonly aliasService: SimpleLoginAliasService,
    private readonly cipherService: AliasReconciliationVault,
    private readonly waitForRetry: Wait = wait,
  ) {}

  async reconcile(userId: UserId, apply: boolean): Promise<AliasReconciliationReport> {
    const ciphers = await this.cipherService.getAllDecrypted(userId);
    const loginCiphers = ciphers.filter((cipher) => cipher.type === CipherType.Login);
    const provider = this.aliasService.providerIdentity();
    const listedAliases = await listAllAliases(this.aliasService, this.waitForRetry);
    const aliases = await recoverOmittedBoundAliases(
      this.aliasService,
      listedAliases,
      loginCiphers,
      provider,
      this.waitForRetry,
    );
    const sdkCiphers = loginCiphers
      .filter((cipher) => cipher.aliasBinding !== undefined)
      .map((cipher) => cipher.toSdkCipherView());
    const beforePlan = plan_alias_reconciliation(provider, aliases, sdkCiphers);
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
        const aliasId =
          action?.alias_id ?? (view?.aliasBinding ? BigInt(view.aliasBinding.aliasId) : undefined);
        const alias = aliases.find((candidate) => candidate.id === aliasId);
        const changeIdentity = alias ? canonicalIdentity(provider, alias) : view?.aliasBinding;
        const change =
          changeIdentity && view
            ? {
                ...cipherReference(view),
                alias: changeIdentity,
              }
            : undefined;
        try {
          if (!view) {
            throw new Error("SDK reconciliation did not return an updated cipher");
          }
          await this.cipherService.updateWithServer(view, userId);
          if (change) {
            changes.push({ ...change, status: "applied" });
          }
        } catch {
          const original = originalById.get(cipherId);
          const outputIndex = finalSdkCiphers.findIndex((cipher) => cipher.id === sdkCipher?.id);
          if (original && outputIndex >= 0) {
            finalSdkCiphers[outputIndex] = original;
          }
          if (change) {
            changes.push({ ...change, status: "failed", reason: "vault-update-failed" });
          }
        }
      }
      finalPlan = plan_alias_reconciliation(provider, aliases, finalSdkCiphers);
    }

    const analysis = analysisFromSdkPlan(finalPlan, aliases, ciphers);
    const appliedChanges = changes.filter((change) => change.status === "applied").length;
    const failedChanges = changes.length - appliedChanges;
    return {
      object: "aliasReconciliation",
      version: ALIAS_RECONCILIATION_REPORT_VERSION,
      provider: "simplelogin",
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
      },
      ...analysis,
      changes,
    };
  }
}
