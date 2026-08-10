import {
  EMAIL_ALIAS_IDENTITY_VERSION,
  normalizeEmailAliasAddress,
} from "@bitwarden/common/tools/alias";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import {
  SimpleLoginAlias,
  SimpleLoginAliasError,
  SimpleLoginAliasService,
  toSimpleLoginAliasIdentity,
} from "@bitwarden/generator-core";

export const ALIAS_RECONCILIATION_REPORT_VERSION = 1 as const;

export type AliasReconciliationVault = Pick<
  CipherService,
  "getAllDecrypted" | "updateWithServer"
>;

export type AliasReconciliationIdentity = {
  version: typeof EMAIL_ALIAS_IDENTITY_VERSION;
  provider: "simplelogin";
  id: string;
  address: string;
};

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
  | "provider-address-not-unique";

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
  unbound: AliasReconciliationMatch[];
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
    unbound: number;
    plannedChanges: number;
    appliedChanges: number;
    failedChanges: number;
  };
  changes: AliasReconciliationChange[];
};

function identity(alias: SimpleLoginAlias): AliasReconciliationIdentity {
  return toSimpleLoginAliasIdentity(alias);
}

function cipherReference(cipher: CipherView): AliasReconciliationCipher {
  return {
    cipherId: cipher.id ?? "",
    username: cipher.login?.username ?? "",
  };
}

function sortByAddressAndId<T extends { address: string; id: string }>(left: T, right: T): number {
  return left.address.localeCompare(right.address) || left.id.localeCompare(right.id);
}

function sortMatches(left: AliasReconciliationMatch, right: AliasReconciliationMatch): number {
  return (
    left.alias.address.localeCompare(right.alias.address) ||
    left.alias.id.localeCompare(right.alias.id) ||
    left.cipherId.localeCompare(right.cipherId)
  );
}

/**
 * Build a deterministic reconciliation plan. Only a one-to-one live provider alias and unbound
 * login username is considered safe to apply automatically.
 */
export function analyzeAliasReconciliation(
  aliases: SimpleLoginAlias[],
  ciphers: CipherView[],
): AliasReconciliationAnalysis {
  const loginCiphers = ciphers.filter(
    (cipher) =>
      cipher.type === CipherType.Login &&
      !cipher.deletedDate &&
      normalizeEmailAliasAddress(cipher.login?.username) !== "",
  );
  const aliasesByAddress = new Map<string, SimpleLoginAlias[]>();
  const aliasesById = new Map<string, SimpleLoginAlias>();
  const ciphersByAddress = new Map<string, CipherView[]>();

  for (const alias of aliases) {
    const address = normalizeEmailAliasAddress(alias.address);
    const matching = aliasesByAddress.get(address) ?? [];
    matching.push(alias);
    aliasesByAddress.set(address, matching);
    aliasesById.set(alias.id.toString(), alias);
  }

  for (const cipher of loginCiphers) {
    const address = normalizeEmailAliasAddress(cipher.login?.username);
    const matching = ciphersByAddress.get(address) ?? [];
    matching.push(cipher);
    ciphersByAddress.set(address, matching);
  }

  const result: AliasReconciliationAnalysis = {
    exactMatches: [],
    duplicates: [],
    conflicts: [],
    missing: [],
    unbound: [],
  };
  const conflictedCipherIds = new Set<string>();

  for (const [address, providerAliases] of aliasesByAddress) {
    const matchingCiphers = ciphersByAddress.get(address) ?? [];
    if (providerAliases.length > 1) {
      const providerIdentities = providerAliases.map(identity).sort(sortByAddressAndId);
      for (const cipher of matchingCiphers) {
        conflictedCipherIds.add(cipher.id ?? "");
        result.conflicts.push({
          ...cipherReference(cipher),
          reason: "provider-address-not-unique",
          binding: cipher.aliasBinding,
          providerAliases: providerIdentities,
        });
      }
      continue;
    }

    const providerAlias = providerAliases[0];
    const aliasIdentity = identity(providerAlias);
    if (matchingCiphers.length === 0) {
      result.missing.push({ kind: "provider-alias-without-login", alias: aliasIdentity });
      continue;
    }

    if (matchingCiphers.length > 1) {
      result.duplicates.push({
        alias: aliasIdentity,
        ciphers: matchingCiphers.map(cipherReference).sort((left, right) =>
          left.cipherId.localeCompare(right.cipherId),
        ),
      });
      continue;
    }

    const cipher = matchingCiphers[0];
    const match = { ...cipherReference(cipher), alias: aliasIdentity };
    if (!cipher.id) {
      conflictedCipherIds.add("");
      result.conflicts.push({
        ...cipherReference(cipher),
        reason: "cipher-id-missing",
        binding: cipher.aliasBinding,
        providerAliases: [aliasIdentity],
      });
    } else if (!cipher.aliasBinding) {
      result.unbound.push(match);
    } else if (
      cipher.aliasBinding.id === aliasIdentity.id &&
      normalizeEmailAliasAddress(cipher.aliasBinding.address) === address
    ) {
      result.exactMatches.push(match);
    } else {
      conflictedCipherIds.add(cipher.id);
      result.conflicts.push({
        ...cipherReference(cipher),
        reason: "binding-does-not-match-provider",
        binding: cipher.aliasBinding,
        providerAliases: [aliasIdentity],
      });
    }
  }

  for (const cipher of loginCiphers) {
    const binding = cipher.aliasBinding;
    if (!binding) {
      continue;
    }

    const address = normalizeEmailAliasAddress(cipher.login?.username);
    const providerAliases = aliasesByAddress.get(address) ?? [];
    const providerAliasById = aliasesById.get(binding.id);
    if (
      providerAliasById &&
      normalizeEmailAliasAddress(providerAliasById.address) !== address &&
      !conflictedCipherIds.has(cipher.id ?? "")
    ) {
      conflictedCipherIds.add(cipher.id ?? "");
      result.conflicts.push({
        ...cipherReference(cipher),
        reason: "binding-does-not-match-provider",
        binding,
        providerAliases: [identity(providerAliasById)],
      });
      continue;
    }

    if (providerAliasById || providerAliases.length > 0) {
      continue;
    }

    result.missing.push({
      ...cipherReference(cipher),
      kind: "bound-login-without-provider-alias",
      binding,
    });
  }

  result.exactMatches.sort(sortMatches);
  result.duplicates.sort((left, right) => sortByAddressAndId(left.alias, right.alias));
  result.conflicts.sort((left, right) =>
    left.username.localeCompare(right.username) || left.cipherId.localeCompare(right.cipherId),
  );
  result.missing.sort((left, right) => {
    const leftAddress =
      left.kind === "provider-alias-without-login" ? left.alias.address : left.username;
    const rightAddress =
      right.kind === "provider-alias-without-login" ? right.alias.address : right.username;
    return leftAddress.localeCompare(rightAddress);
  });
  result.unbound.sort(sortMatches);

  return result;
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
  for (let attempt = 0; ; attempt++) {
    try {
      return await aliasService.list(page);
    } catch (error) {
      if (!(error instanceof SimpleLoginAliasError) || error.code !== "rate-limited" || attempt >= 2) {
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
): Promise<SimpleLoginAlias[]> {
  const aliases: SimpleLoginAlias[] = [];
  let page = 0;
  const seenPages = new Set<number>();

  while (!seenPages.has(page)) {
    seenPages.add(page);
    const result = await listAliasPageWithRetry(aliasService, page, waitForRetry);
    aliases.push(...result.items);
    if (result.nextPage === undefined) {
      break;
    }
    page = result.nextPage;
  }

  return aliases;
}

export class AliasReconciliationService {
  constructor(
    private readonly aliasService: SimpleLoginAliasService,
    private readonly cipherService: AliasReconciliationVault,
    private readonly waitForRetry: Wait = wait,
  ) {}

  async reconcile(userId: UserId, apply: boolean): Promise<AliasReconciliationReport> {
    const aliases = await listAllAliases(this.aliasService, this.waitForRetry);
    const ciphers = await this.cipherService.getAllDecrypted(userId);
    const loginCiphers = ciphers.filter((cipher) => cipher.type === CipherType.Login);
    const before = analyzeAliasReconciliation(aliases, ciphers);
    const changes: AliasReconciliationChange[] = [];

    if (apply) {
      const ciphersById = new Map(ciphers.map((cipher) => [cipher.id ?? "", cipher]));
      for (const planned of before.unbound) {
        const cipher = ciphersById.get(planned.cipherId);
        if (
          !cipher ||
          cipher.aliasBinding ||
          normalizeEmailAliasAddress(cipher.login?.username) !==
            normalizeEmailAliasAddress(planned.alias.address)
        ) {
          changes.push({ ...planned, status: "failed", reason: "vault-update-failed" });
          continue;
        }

        cipher.aliasBinding = planned.alias;
        try {
          await this.cipherService.updateWithServer(cipher, userId);
          changes.push({ ...planned, status: "applied" });
        } catch {
          delete cipher.aliasBinding;
          changes.push({ ...planned, status: "failed", reason: "vault-update-failed" });
        }
      }
    }

    const analysis = apply ? analyzeAliasReconciliation(aliases, ciphers) : before;
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
        unbound: analysis.unbound.length,
        plannedChanges: before.unbound.length,
        appliedChanges,
        failedChanges,
      },
      ...analysis,
      changes,
    };
  }
}
