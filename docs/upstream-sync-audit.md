# Public clients upstream compatibility audit

This repository audits a proposed public Bitwarden upstream commit before maintainers integrate it. The audit is read-only with respect to Git history: it resolves commits, computes diffs, and asks `git merge-tree` for a virtual merge. It does not check out the candidate, merge it, build an application, read repository secrets, or inspect file contents under `bitwarden_license/`.

The automation was introduced from this exact base:

- base ref at creation: `origin/main`
- base commit: `1f881babc15eb7d3a88cad41730ce167d8e49a41`
- base subject: `[CL-51] create file upload component (#20899)`

The recorded hash is provenance for this audit change. It is not a moving upstream pointer and should not be updated during routine intake.

## What the audit reports

The JSON and Markdown reports contain the resolved base, upstream, and fork commit IDs plus the policy digest. They classify:

- paths changed only upstream, only in the fork, or on both sides;
- overlapping paths as identical changes, clean overlaps, or merge conflicts;
- changes to licensing/commercial boundaries, extension code, mobile/native surfaces, crypto/authentication, autofill, release/update mechanisms, lockfiles/toolchains, package patches, generated artifacts, and GitHub automation;
- newly reachable commercial source references from public source files, relative to the common ancestor;
- fork-side changes under `bitwarden_license/`;
- configured generator input/output drift;
- newly added personal migration paths, personal filesystem paths, private-network URLs/domains, and other domain-specific URLs that require review.

Conflicts, high-risk changes, lockfile/toolchain changes, package-patch changes, and unfamiliar public domains are review information. They do not fail the command by themselves. Exit status `1` is reserved for explicit, unallowlisted policy violations. Invalid refs, policy, or Git state use exit status `2`.

Commercial reachability is a conservative source-reference check, not a dependency-graph build. It deliberately scans public text blobs from Git and never reads commercial-source blobs. Existing boundary references at the common ancestor are the baseline, so the gate exposes new reachability instead of forcing a broad pre-existing exception list.

## Local dry run

Ensure the candidate commit exists locally, then run:

```bash
git fetch --no-tags upstream refs/heads/main:refs/upstream-sync-audit/candidate
node scripts/upstream-sync-audit/audit.mjs \
  --upstream refs/upstream-sync-audit/candidate \
  --fork HEAD \
  --dry-run
```

The dry run prints the Markdown report and writes nothing. Omit `--dry-run` to create:

```text
.artifacts/upstream-sync-audit/report.json
.artifacts/upstream-sync-audit/report.md
```

The default upstream ref is `upstream/main`, the default fork ref is `HEAD`, and the default comparison base is their common ancestor. `UPSTREAM_REF`, `FORK_REF`, and `BASE_REF` provide environment-variable equivalents. Run `node scripts/upstream-sync-audit/audit.mjs --help` for all options.

The focused test suite creates tiny temporary Git histories and needs only Node and Git:

```bash
node --test scripts/upstream-sync-audit/audit.test.mjs
```

## Routine upstream intake

1. Fetch the proposed public upstream branch or tag into a dedicated non-branch ref. Do not merge or fetch into `main`.
2. Run a dry audit and archive the resolved commit IDs. Never review a moving ref without recording the resolved hash.
3. Triage explicit violations first. Do not start conflict resolution while a commercial-boundary, generated-source, or forbidden-code violation is unexplained.
4. Review every merge conflict and clean overlap. A clean virtual merge only proves textual mergeability, not behavioral compatibility.
5. Assign reviewers for each reported high-risk surface. Lockfiles should be paired with their manifest/toolchain intent; patches should be paired with their target package change; generated outputs should be paired with generator inputs or a documented regeneration reason.
6. Integrate the pinned upstream commit on a dedicated intake branch using the project's chosen rebase, merge, or cherry-pick strategy. This audit does not choose or execute that strategy.
7. Re-run the audit against the integrated commit, then run the scoped application checks appropriate to the reported risk surfaces. Full builds and tests are intentionally outside this lightweight gate.

CI follows the same model. The workflow accepts only a full `refs/heads/*` or `refs/tags/*` public upstream ref, fetches it into `refs/upstream-sync-audit/candidate`, runs the synthetic tests, writes both reports, adds the Markdown report to the job summary, and uploads both report files. It uses read-only repository permissions and no secrets.

## Policy and allowlist maintenance

The policy lives at `scripts/upstream-sync-audit/policy.json`. Prefer adding a risk glob, generated source/artifact pair, or narrowly defined forbidden rule over hard-coding behavior in the script. Review policy changes independently from an upstream intake whenever possible.

Allowlisting does not remove a finding. A matching violation remains in both reports with `allowed: true`, its exact fingerprint, and the required reason. The command also reports stale allowlist entries so they can be removed instead of silently accumulating.

To approve a genuine exception:

1. Run the audit and copy the exact finding fingerprint from `report.json` or `report.md`.
2. Confirm that the path and detail are as narrow as intended. Fingerprints bind the rule, path, and matched detail; changed drift produces a new violation.
3. Add an object to `policy.json` under `allowlist`:

   ```json
   {
     "fingerprint": "rule-id:0123456789abcdef",
     "reason": "Issue or review explaining why this exact finding is safe"
   }
   ```

4. Re-run the audit and verify that the finding is still visible as allowlisted and that no unrelated finding was suppressed.
5. Remove the entry when it becomes stale. Do not broaden a forbidden regular expression or add a source path to `scanExcludes` merely to make intake pass.

`domainReviewAllowlist` is different: it suppresses only non-failing review notices for well-known public domains. Forbidden domain rules still take precedence. Keep domain entries at the registrable-domain level only when every subdomain is acceptable; otherwise use the exact hostname.
