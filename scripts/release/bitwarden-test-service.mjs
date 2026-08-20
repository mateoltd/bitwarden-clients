import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

import { assert, parseArgs, readManifest, repositoryRoot, requireString } from "./lib.mjs";

const manifest = readManifest();
const runtime = manifest.testInfrastructure;
const officialNetwork = "alias-client-release-bitwarden-network";
const compatibilityNetwork = "alias-client-release-vault-network";

function docker(args, { allowFailure = false, capture = false } = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed with status ${result.status}`);
  }
  return result;
}

function assertAbsoluteDirectory(value, option) {
  const directory = path.resolve(requireString(value, `${option} is required`));
  assert(path.isAbsolute(value), `${option} must be absolute`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function waitFor(predicate, description, timeoutMilliseconds = 120_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${detail}`);
}

async function httpReady(url) {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(2_000),
  });
  return response.status < 400;
}

function httpsReady(url) {
  return new Promise((resolve) => {
    const request = https.get(url, { rejectUnauthorized: false, timeout: 2_000 }, (response) => {
      response.resume();
      resolve((response.statusCode ?? 500) < 400);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

class DockerBitwardenService {
  constructor({ containerName, networkName, runtimeDirectory }) {
    this.containerName = containerName;
    this.networkName = networkName;
    this.runtimeDirectory = runtimeDirectory;
    this.proxyPid = path.join(runtimeDirectory, "bitwarden-tls-proxy.pid");
    this.proxyLog = path.join(runtimeDirectory, "bitwarden-tls-proxy.log");
  }

  stopContainer() {
    docker(["rm", "--force", this.containerName], { allowFailure: true, capture: true });
  }

  stopNetwork() {
    docker(["network", "rm", this.networkName], { allowFailure: true, capture: true });
  }

  createNetwork() {
    this.stopNetwork();
    docker(["network", "create", this.networkName], { capture: true });
  }

  logs() {
    return docker(["logs", "--tail", "160", this.containerName], {
      allowFailure: true,
      capture: true,
    });
  }

  stop() {
    this.stopProxy();
    this.stopContainer();
    this.stopNetwork();
  }

  stopProxy() {
    if (!fs.existsSync(this.proxyPid)) return;
    const pid = Number(fs.readFileSync(this.proxyPid, "utf8").trim());
    if (Number.isSafeInteger(pid) && pid > 1) {
      const processRecord = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
      });
      if (
        processRecord.status === 0 &&
        processRecord.stdout.includes("scripts/release/vault-tls-proxy.mjs")
      ) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }
    fs.rmSync(this.proxyPid, { force: true });
  }

  startProxy() {
    this.stopProxy();
    const log = fs.openSync(this.proxyLog, "a", 0o600);
    const child = spawn(
      process.execPath,
      [path.join(repositoryRoot, "scripts/release/vault-tls-proxy.mjs")],
      {
        detached: true,
        env: { ...process.env, VAULT_HTTP_TARGET: "http://127.0.0.1:18080" },
        stdio: ["ignore", log, log],
      },
    );
    child.unref();
    fs.closeSync(log);
    fs.writeFileSync(this.proxyPid, `${child.pid}\n`, { mode: 0o600 });
  }

  startContainer(args) {
    this.stopContainer();
    this.createNetwork();
    docker(
      ["run", "--detach", "--name", this.containerName, "--network", this.networkName, ...args],
      { capture: true },
    );
  }

  async startWithRollback(start) {
    try {
      await start();
    } catch (error) {
      const logs = this.logs();
      process.stderr.write(`${logs.stdout ?? ""}${logs.stderr ?? ""}`);
      this.stop();
      throw error;
    }
  }
}

class OfficialBitwardenService extends DockerBitwardenService {
  constructor(dataDirectory, runtimeDirectory) {
    super({
      containerName: runtime.officialBitwarden.containerName,
      networkName: officialNetwork,
      runtimeDirectory,
    });
    this.dataDirectory = dataDirectory;
    fs.mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 });
    this.database = path.join(dataDirectory, "vault.db");
  }

  async start() {
    fs.chmodSync(this.dataDirectory, 0o777);
    await this.startWithRollback(async () => {
      this.startContainer([
        "--publish",
        "127.0.0.1:18080:8080",
        "--volume",
        `${this.dataDirectory}:/etc/bitwarden`,
        "--env",
        "BW_DOMAIN=localhost",
        "--env",
        "BW_PORT_HTTP=8080",
        "--env",
        "BW_ENABLE_SSL=false",
        "--env",
        "BW_DB_PROVIDER=sqlite",
        "--env",
        "BW_DB_FILE=/etc/bitwarden/vault.db",
        "--env",
        "BW_INSTALLATION_ID=11111111-1111-4111-8111-111111111111",
        "--env",
        "BW_INSTALLATION_KEY=local-qualification-only",
        "--env",
        "BW_ENABLE_ADMIN=true",
        "--env",
        "BW_ENABLE_API=true",
        "--env",
        "BW_ENABLE_IDENTITY=true",
        "--env",
        "BW_ENABLE_EVENTS=false",
        "--env",
        "BW_ENABLE_ICONS=false",
        "--env",
        "BW_ENABLE_NOTIFICATIONS=false",
        "--env",
        "BW_ENABLE_SSO=false",
        "--env",
        "BW_ENABLE_SCIM=false",
        "--env",
        "globalSettings__baseServiceUri__vault=https://localhost:18443",
        "--env",
        "globalSettings__internalIdentityKey=",
        "--env",
        "globalSettings__pushRelayBaseUri=",
        "--env",
        "globalSettings__identityServer__certificatePassword=local-qualification-certificate",
        "--env",
        "globalSettings__disableUserRegistration=false",
        "--env",
        "globalSettings__enableEmailVerification=false",
        runtime.officialBitwarden.image,
      ]);

      await waitFor(async () => {
        if (
          !(await httpReady("http://127.0.0.1:18080/api/alive")) ||
          !(await httpReady("http://127.0.0.1:18080/identity/.well-known/openid-configuration")) ||
          !(await httpReady("http://127.0.0.1:18080/admin/"))
        ) {
          return false;
        }
        return fs.existsSync(this.database);
      }, "official Bitwarden API, Identity, and migrated SQLite schema");
      this.startProxy();
      await waitFor(() => httpsReady("https://localhost:18443/api/alive"), "Bitwarden TLS proxy");
    });

    console.log(
      JSON.stringify({
        service: "official-bitwarden",
        version: runtime.officialBitwarden.version,
        sourceCommit: runtime.officialBitwarden.sourceCommit,
        image: runtime.officialBitwarden.image,
        database: this.database,
        network: this.networkName,
        apiReady: true,
        identityReady: true,
        tlsReady: true,
        schemaReady: true,
      }),
    );
  }
}

class VaultwardenCompatibilityService extends DockerBitwardenService {
  constructor(dataDirectory, runtimeDirectory) {
    super({
      containerName: runtime.vault.containerName,
      networkName: compatibilityNetwork,
      runtimeDirectory,
    });
    this.dataDirectory = dataDirectory;
    fs.mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 });
  }

  async start() {
    fs.chmodSync(this.dataDirectory, 0o777);
    await this.startWithRollback(async () => {
      this.startContainer([
        "--publish",
        "127.0.0.1:18080:80",
        "--volume",
        `${this.dataDirectory}:/data`,
        "--env",
        "DOMAIN=https://localhost:18443",
        "--env",
        "SIGNUPS_ALLOWED=true",
        "--env",
        "SIGNUPS_VERIFY=false",
        runtime.vault.image,
      ]);
      await waitFor(
        () => httpReady("http://127.0.0.1:18080/alive"),
        "Vaultwarden compatibility API",
      );
      this.startProxy();
      await waitFor(() => httpsReady("https://localhost:18443/alive"), "Vaultwarden TLS proxy");
    });

    console.log(
      JSON.stringify({
        service: "vaultwarden-compatibility",
        version: runtime.vault.version,
        image: runtime.vault.image,
        database: path.join(this.dataDirectory, "db.sqlite3"),
        network: this.networkName,
        apiReady: true,
        tlsReady: true,
      }),
    );
  }
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const runtimeDirectory = assertAbsoluteDirectory(args["runtime-directory"], "--runtime-directory");
const official = new OfficialBitwardenService(
  path.join(runtimeDirectory, "official-data"),
  runtimeDirectory,
);
const compatibility = new VaultwardenCompatibilityService(
  path.join(runtimeDirectory, "vaultwarden-data"),
  runtimeDirectory,
);

if (command === "start-official") {
  compatibility.stop();
  await official.start();
} else if (command === "start-vaultwarden") {
  official.stop();
  await compatibility.start();
} else if (command === "stop") {
  official.stop();
  compatibility.stop();
  console.log(JSON.stringify({ service: "bitwarden-test-services", stopped: true }));
} else {
  throw new Error("Expected start-official, start-vaultwarden, or stop");
}
