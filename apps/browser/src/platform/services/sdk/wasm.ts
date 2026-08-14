import * as aliasSdk from "@bitwarden/alias-sdk-internal";
import * as aliasWasm from "@bitwarden/alias-sdk-internal/bitwarden_wasm_internal_bg.wasm";
import * as sdk from "@bitwarden/sdk-internal";
import * as wasm from "@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.wasm";

import { GlobalWithWasmInit } from "./browser-sdk-load.service";

(globalThis as GlobalWithWasmInit).initSdk = () => {
  (sdk as any).init(wasm);
  (aliasSdk as any).init(aliasWasm);
};
