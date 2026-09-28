import fs from "node:fs";
import path from "node:path";

import { assert, parseArgs, requireString } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const browserExit = Number(requireString(args["browser-exit"], "--browser-exit is required"));
const browserLogPath = path.resolve(
  requireString(args["browser-log"], "--browser-log is required"),
);
const serverLogPath = path.resolve(requireString(args["server-log"], "--server-log is required"));
const browserLog = fs.readFileSync(browserLogPath, "utf8");
const serverLog = fs.readFileSync(serverLogPath, "utf8");

assert(
  Number.isSafeInteger(browserExit) && browserExit !== 0,
  "Vaultwarden unexpectedly accepted v1",
);
const shapeLines = browserLog
  .split(/\r?\n/)
  .filter((line) => line.startsWith("BITWARDEN_CIPHER_REQUEST_SHAPE "));
assert(shapeLines.length === 1, "Expected exactly one value-free cipher request shape");
const shape = JSON.parse(shapeLines[0].slice("BITWARDEN_CIPHER_REQUEST_SHAPE ".length));
assert(shape.data === "non-empty-string", "Encrypted top-level data was not sent");
assert(shape.sensitivePlaintext === "absent", "Sensitive plaintext entered top-level data");
assert(shape.login === "absent", "Legacy login request data was unexpectedly sent");
assert(shape.fields === "absent", "Legacy fields request data was unexpectedly sent");
assert(
  /BITWARDEN_PROXY_RESPONSE POST \/(?:api\/)?ciphers 400/.test(browserLog),
  "Pinned Vaultwarden did not return HTTP 400 for the cipher request",
);
assert(
  /Data missing/i.test(serverLog),
  "Pinned Vaultwarden did not reject the missing legacy Data",
);

console.log(
  JSON.stringify({
    server: "Vaultwarden",
    version: "1.37.1",
    browserExit,
    encryptedTopLevelData: true,
    legacyLogin: false,
    legacyFields: false,
    responseStatus: 400,
    rejection: "Data missing",
  }),
);
