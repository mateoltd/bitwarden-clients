import { SensitiveString } from "@bitwarden/alias-sdk-internal";

import {
  AliasSyncDocument,
  AliasSyncEvent,
  AliasSyncEventInput,
  aliasConnectionKey,
  appendAliasSyncEvent,
  createAliasSyncDocument,
  emailAliasKey,
  mergeAliasSyncDocuments,
  parseAliasSyncDocument,
  pendingAliasReferenceTransactions,
  projectAliasSync,
} from "./alias-sync";

const replicaA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const replicaB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const replicaC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const connectionId = "11111111-1111-4111-8111-111111111111";
const connection = {
  version: 1 as const,
  connectionId,
};
const sensitive = (value: string): SensitiveString => value as SensitiveString;
const alias = {
  version: 1 as const,
  connectionId,
  aliasId: "41",
  address: sensitive("first@sl.test"),
};

function eventId(value: number): string {
  return `${value.toString(16).padStart(8, "0")}-0000-4000-8000-${value
    .toString(16)
    .padStart(12, "0")}`;
}

function append(
  document: AliasSyncDocument,
  input: AliasSyncEventInput,
  value: number,
): AliasSyncDocument {
  return appendAliasSyncEvent(document, input, eventId(value));
}

function shuffled<T>(source: T[], seed: number): T[] {
  const result = [...source];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index--) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

describe("alias synchronization state machine", () => {
  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["malformed", "1"],
    ["version 2", 2],
    ["unknown", 99],
  ])("rejects a %s journal schema version", (_name, version) => {
    expect(() => parseAliasSyncDocument({ ...createAliasSyncDocument(replicaA), version })).toThrow(
      "Unsupported alias sync document version",
    );
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["malformed", "1"],
    ["version 2", 2],
    ["unknown", 99],
  ])("rejects a %s journal event schema version", (_name, version) => {
    const event = append(
      createAliasSyncDocument(replicaA),
      { kind: "connection-upsert", connection },
      900,
    ).events[0];

    expect(() =>
      parseAliasSyncDocument({
        version: 1,
        replicaId: replicaA,
        clock: event.clock,
        events: [{ ...event, version }],
      }),
    ).toThrow("Unsupported alias sync event version");
  });

  it("converges for duplicate, reordered, and stale event snapshots", () => {
    let first = createAliasSyncDocument(replicaA);
    first = append(first, { kind: "connection-upsert", connection }, 1);
    first = append(
      first,
      {
        kind: "provider-observe",
        snapshot: { alias, lifecycle: "enabled" },
      },
      2,
    );

    let second = mergeAliasSyncDocuments(createAliasSyncDocument(replicaB), first);
    second = append(
      second,
      {
        kind: "provider-operation",
        value: { operation: "disable", alias },
      },
      3,
    );

    let third = mergeAliasSyncDocuments(createAliasSyncDocument(replicaC), first);
    third = append(
      third,
      { kind: "provider-operation", value: { operation: "disable", alias } },
      4,
    );

    const expected = projectAliasSync(mergeAliasSyncDocuments(first, second, third));
    for (let seed = 1; seed <= 100; seed++) {
      const inputs = shuffled([first, second, third, first, third], seed);
      const merged = mergeAliasSyncDocuments(inputs[0], ...inputs.slice(1));
      expect(projectAliasSync(merged)).toEqual(expected);
    }
    expect(expected.aliases[emailAliasKey(alias)]).toMatchObject({
      status: "disabled",
    });
  });

  it("makes provider deletion and connection removal terminal across stale replicas", () => {
    let active = createAliasSyncDocument(replicaA);
    active = append(active, { kind: "connection-upsert", connection }, 10);
    active = append(
      active,
      { kind: "provider-operation", value: { operation: "enable", alias } },
      11,
    );

    let deletion = mergeAliasSyncDocuments(createAliasSyncDocument(replicaB), active);
    deletion = append(
      deletion,
      { kind: "provider-operation", value: { operation: "delete", alias } },
      12,
    );
    deletion = append(deletion, { kind: "connection-remove", connection }, 13);

    let stale = createAliasSyncDocument(replicaC);
    stale = append(stale, { kind: "connection-upsert", connection }, 14);
    stale = append(
      stale,
      { kind: "provider-operation", value: { operation: "enable", alias } },
      15,
    );

    const projection = projectAliasSync(mergeAliasSyncDocuments(stale, deletion, active));
    expect(projection.connections[aliasConnectionKey(connection)].status).toBe("removed");
    expect(projection.aliases[emailAliasKey(alias)].status).toBe("deleted");
    expect(projection.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "connection-removed" }),
        expect.objectContaining({ kind: "provider-state" }),
      ]),
    );
  });

  it("keeps a concurrent reference retarget unresolved until an explicit resolution observes it", () => {
    const originalKey = emailAliasKey(alias);
    const secondAlias = { ...alias, aliasId: "42", address: sensitive("second@sl.test") };
    const thirdAlias = { ...alias, aliasId: "43", address: sensitive("third@sl.test") };
    let left = createAliasSyncDocument(replicaA);
    left = append(
      left,
      {
        kind: "reference-set",
        cipherId: "cipher-1",
        expectedAliasKey: originalKey,
        alias: secondAlias,
      },
      20,
    );
    let right = createAliasSyncDocument(replicaB);
    right = append(
      right,
      {
        kind: "reference-set",
        cipherId: "cipher-1",
        expectedAliasKey: originalKey,
        alias: thirdAlias,
      },
      21,
    );

    let merged = mergeAliasSyncDocuments(left, right);
    const unresolved = projectAliasSync(merged);
    const conflict = unresolved.conflicts.find((entry) => entry.kind === "reference-retarget")!;
    expect(unresolved.references["cipher-1"]).toEqual({
      cipherId: "cipher-1",
      alias: undefined,
      conflicted: true,
    });

    merged = append(
      merged,
      { kind: "conflict-resolve", conflictId: conflict.id, chosenEventId: right.events[0].id },
      22,
    );
    expect(projectAliasSync(merged).references["cipher-1"]).toMatchObject({
      alias: thirdAlias,
      conflicted: false,
    });
  });

  it("rejects a causally newer reference write whose compare-and-set snapshot is stale", () => {
    const secondAlias = { ...alias, aliasId: "42", address: sensitive("second@sl.test") };
    const thirdAlias = { ...alias, aliasId: "43", address: sensitive("third@sl.test") };
    let document = createAliasSyncDocument(replicaA);
    document = append(
      document,
      {
        kind: "reference-set",
        cipherId: "cipher-cas",
        expectedAliasKey: null,
        alias: secondAlias,
      },
      23,
    );
    document = append(
      document,
      {
        kind: "reference-set",
        cipherId: "cipher-cas",
        expectedAliasKey: null,
        alias: thirdAlias,
      },
      24,
    );

    const projection = projectAliasSync(document);
    expect(projection.references["cipher-cas"]).toMatchObject({
      alias: secondAlias,
      conflicted: false,
    });
    expect(projection.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "reference-precondition" })]),
    );
  });

  it("accepts a sequential reference retarget only when it names the observed value", () => {
    const secondAlias = { ...alias, aliasId: "42", address: sensitive("second@sl.test") };
    const thirdAlias = { ...alias, aliasId: "43", address: sensitive("third@sl.test") };
    let document = createAliasSyncDocument(replicaA);
    document = append(
      document,
      {
        kind: "reference-set",
        cipherId: "cipher-cas",
        expectedAliasKey: null,
        alias: secondAlias,
      },
      25,
    );
    document = append(
      document,
      {
        kind: "reference-set",
        cipherId: "cipher-cas",
        expectedAliasKey: emailAliasKey(secondAlias),
        alias: thirdAlias,
      },
      26,
    );

    expect(projectAliasSync(document).references["cipher-cas"]).toMatchObject({
      alias: thirdAlias,
      conflicted: false,
    });
  });

  it("keeps a prepared reference inert until a causally valid commit", () => {
    const replacement = {
      ...alias,
      aliasId: "42",
      address: sensitive("replacement@sl.test"),
    };
    let document = createAliasSyncDocument(replicaA);
    document = append(
      document,
      {
        kind: "reference-prepare",
        cipherId: "cipher-transaction",
        expectedAlias: alias,
        alias: replacement,
      },
      260,
    );
    const transactionId = document.events.at(-1)?.id ?? "";
    expect(transactionId).toBeDefined();
    expect(projectAliasSync(document).references["cipher-transaction"]).toBeUndefined();
    expect(pendingAliasReferenceTransactions(document)).toEqual([
      expect.objectContaining({ transactionId, status: "pending" }),
    ]);

    document = append(document, { kind: "reference-commit", transactionId: transactionId }, 261);

    expect(projectAliasSync(document).references["cipher-transaction"]).toMatchObject({
      alias: replacement,
      conflicted: false,
    });
    expect(pendingAliasReferenceTransactions(document)).toEqual([]);
  });

  it("keeps an aborted reference transaction out of the committed projection", () => {
    let document = createAliasSyncDocument(replicaA);
    document = append(
      document,
      {
        kind: "reference-prepare",
        cipherId: "cipher-aborted",
        expectedAlias: null,
        alias,
      },
      262,
    );
    const transactionId = document.events.at(-1)?.id ?? "";
    expect(transactionId).toBeDefined();
    document = append(document, { kind: "reference-abort", transactionId: transactionId }, 263);

    expect(projectAliasSync(document).references["cipher-aborted"]).toBeUndefined();
    expect(projectAliasSync(document).referenceTransactions[transactionId].status).toBe("aborted");
  });

  it("projects pending and committed reference transactions safely across devices", () => {
    let source = createAliasSyncDocument(replicaA);
    source = append(
      source,
      {
        kind: "reference-prepare",
        cipherId: "cipher-cross-device",
        expectedAlias: null,
        alias,
      },
      264,
    );
    const transactionId = source.events.at(-1)?.id ?? "";
    expect(transactionId).toBeDefined();
    let remote = mergeAliasSyncDocuments(createAliasSyncDocument(replicaB), source);

    expect(pendingAliasReferenceTransactions(remote)).toEqual([]);
    expect(projectAliasSync(remote).references["cipher-cross-device"]).toBeUndefined();

    source = append(source, { kind: "reference-commit", transactionId: transactionId }, 265);
    remote = mergeAliasSyncDocuments(remote, source);

    expect(projectAliasSync(remote).references["cipher-cross-device"]).toMatchObject({
      alias,
      conflicted: false,
    });
  });

  it("rejects a confused deputy settling another replica's reference transaction", () => {
    let owner = createAliasSyncDocument(replicaA);
    owner = append(
      owner,
      {
        kind: "reference-prepare",
        cipherId: "cipher-confused-deputy",
        expectedAlias: null,
        alias,
      },
      266,
    );
    const transactionId = owner.events.at(-1)?.id ?? "";
    expect(transactionId).toBeDefined();
    let deputy = mergeAliasSyncDocuments(createAliasSyncDocument(replicaB), owner);
    deputy = append(deputy, { kind: "reference-commit", transactionId: transactionId }, 267);

    const projection = projectAliasSync(deputy);
    expect(projection.references["cipher-confused-deputy"]).toBeUndefined();
    expect(projection.referenceTransactions[transactionId].status).toBe("conflicted");
    expect(projection.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "event-integrity" })]),
    );
  });

  it("retains concurrent conflicting conflict resolutions", () => {
    let left = createAliasSyncDocument(replicaA);
    left = append(left, { kind: "provider-operation", value: { operation: "enable", alias } }, 27);
    let right = createAliasSyncDocument(replicaB);
    right = append(
      right,
      { kind: "provider-operation", value: { operation: "disable", alias } },
      28,
    );
    const merged = mergeAliasSyncDocuments(left, right);
    const stateConflict = projectAliasSync(merged).conflicts.find(
      (entry) => entry.kind === "provider-state",
    )!;
    left = mergeAliasSyncDocuments(left, right);
    left = append(
      left,
      {
        kind: "conflict-resolve",
        conflictId: stateConflict.id,
        chosenEventId: stateConflict.eventIds[0],
      },
      29,
    );
    right = mergeAliasSyncDocuments(right, merged);
    right = append(
      right,
      {
        kind: "conflict-resolve",
        conflictId: stateConflict.id,
        chosenEventId: stateConflict.eventIds[1],
      },
      30,
    );

    expect(projectAliasSync(mergeAliasSyncDocuments(left, right)).conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "provider-state" }),
        expect.objectContaining({ kind: "event-integrity" }),
      ]),
    );
  });

  it("uses causal clocks instead of device wall clocks and retains simultaneous state conflicts", () => {
    let left = createAliasSyncDocument(replicaA);
    left = append(left, { kind: "provider-operation", value: { operation: "enable", alias } }, 30);
    let right = createAliasSyncDocument(replicaB);
    right = append(
      right,
      { kind: "provider-operation", value: { operation: "disable", alias } },
      31,
    );

    const projection = projectAliasSync(mergeAliasSyncDocuments(left, right));
    expect(projection.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "provider-state" })]),
    );
    expect(["enabled", "disabled"]).toContain(projection.aliases[emailAliasKey(alias)].status);
    expect(JSON.stringify(left)).not.toContain("Date");
    expect(JSON.stringify(right)).not.toContain("issuedAt");
  });

  it("journals unknown provider outcomes without credentials and without treating them as applied", () => {
    let document = createAliasSyncDocument(replicaA);
    document = append(
      document,
      {
        kind: "provider-operation",
        value: {
          operation: "create",
          connection,
          request: { hostname: "signup.example" },
        },
      },
      40,
    );
    const operationId = document.events[0].id;
    document = append(document, { kind: "provider-dispatched", operationId }, 41);
    document = append(document, { kind: "provider-unknown", operationId }, 42);

    expect(projectAliasSync(document).operations[operationId].status).toBe("unknown");
    expect(projectAliasSync(document).conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "provider-outcome-unknown" })]),
    );
    expect(JSON.stringify(document)).not.toContain("credential");
    expect(() =>
      append(
        document,
        {
          kind: "provider-operation",
          value: {
            operation: "create",
            connection,
            request: { token: "provider-secret" } as never,
          },
        },
        43,
      ),
    ).toThrow("Provider credentials cannot be written");
  });

  it("fails closed instead of silently ignoring an unknown restored event kind", () => {
    const document = createAliasSyncDocument(replicaA);
    expect(() =>
      projectAliasSync({
        ...document,
        clock: { [replicaA]: 1 },
        events: [
          {
            version: 1,
            id: eventId(43),
            replicaId: replicaA,
            clock: { [replicaA]: 1 },
            kind: "provider-compatibility-event",
          } as unknown as AliasSyncEvent,
        ],
      }),
    ).toThrow("Unsupported alias sync event kind");
  });

  it("quarantines provider-native and unknown fields at every journal boundary", () => {
    expect(() =>
      append(
        createAliasSyncDocument(replicaA),
        {
          kind: "connection-upsert",
          connection: { ...connection, provider: "simplelogin" },
        } as never,
        431,
      ),
    ).toThrow("Invalid alias sync connection");
    expect(() =>
      append(
        createAliasSyncDocument(replicaA),
        {
          kind: "provider-observe",
          snapshot: { alias, lifecycle: "enabled", note: "provider-native" },
        } as never,
        432,
      ),
    ).toThrow("Invalid alias sync provider snapshot");
    expect(() =>
      parseAliasSyncDocument({
        ...createAliasSyncDocument(replicaA),
        providerInstance: "https://provider.invalid/",
      }),
    ).toThrow("Invalid alias sync document");
  });

  it("projects provider stages independently of replay order", () => {
    let document = createAliasSyncDocument(replicaA);
    document = append(
      document,
      { kind: "provider-operation", value: { operation: "disable", alias } },
      44,
    );
    const operationId = document.events[0].id;
    document = append(document, { kind: "provider-dispatched", operationId }, 45);
    document = append(
      document,
      {
        kind: "provider-ack",
        operationId,
        snapshot: { alias, lifecycle: "disabled" },
      },
      46,
    );
    document = { ...document, events: [...document.events].reverse() };

    expect(projectAliasSync(document).operations[operationId].status).toBe("applied");
  });

  it("does not project a definitively failed provider mutation as applied state", () => {
    let document = createAliasSyncDocument(replicaA);
    document = append(
      document,
      { kind: "provider-observe", snapshot: { alias, lifecycle: "enabled" } },
      47,
    );
    document = append(
      document,
      { kind: "provider-operation", value: { operation: "delete", alias } },
      48,
    );
    const operationId = document.events.at(-1)!.id;
    document = append(document, { kind: "provider-dispatched", operationId }, 49);
    document = append(document, { kind: "provider-failed", operationId, reason: "forbidden" }, 50);

    const projection = projectAliasSync(document);
    expect(projection.operations[operationId]).toMatchObject({ status: "failed" });
    expect(projection.aliases[emailAliasKey(alias)]).toMatchObject({
      status: "enabled",
    });
  });

  it("projects 10,000 independently persisted vault references within the regression budget", () => {
    const events: AliasSyncEvent[] = [];
    const clock: Record<string, number> = {};
    for (let index = 1; index <= 10_000; index++) {
      clock[replicaA] = index;
      events.push({
        version: 1,
        id: eventId(100_000 + index),
        replicaId: replicaA,
        clock: { ...clock },
        kind: "reference-set",
        cipherId: `cipher-${index}`,
        expectedAliasKey: null,
        alias: {
          ...alias,
          aliasId: String(index),
          address: sensitive(`alias-${index}@sl.test`),
        },
      });
    }
    const document: AliasSyncDocument = {
      version: 1,
      replicaId: replicaA,
      clock,
      events,
    };

    const start = performance.now();
    const projection = projectAliasSync(document);
    const elapsed = performance.now() - start;

    expect(Object.keys(projection.references)).toHaveLength(10_000);
    expect(projection.conflicts).toHaveLength(0);
    expect(elapsed).toBeLessThan(5_000);
  });
});
