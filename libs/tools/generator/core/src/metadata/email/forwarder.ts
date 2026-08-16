import { Jsonify } from "type-fest";

import { parseAliasSyncDocument } from "@bitwarden/common/tools/alias";
import { ExtensionMetadata, ExtensionStorageKey } from "@bitwarden/common/tools/extension/type";
import { Vendor } from "@bitwarden/common/tools/extension/vendor/data";
import { IdentityConstraint } from "@bitwarden/common/tools/state/identity-state-constraint";

import { getForwarderConfiguration } from "../../data";
import { Forwarder } from "../../engine/forwarder";
import { SimpleLoginForwarder } from "../../engine/simple-login-forwarder";
import { GeneratorDependencyProvider } from "../../providers";
import { ForwarderOptions } from "../../types";
import { Profile, Type } from "../data";
import { GeneratorMetadata } from "../generator-metadata";
import { ForwarderProfileMetadata } from "../profile-metadata";

function deserializeForwarderOptions(value: Jsonify<ForwarderOptions>): ForwarderOptions {
  const { aliasSync, ...options } = value;
  return {
    ...options,
    ...(aliasSync === undefined ? {} : { aliasSync: parseAliasSyncDocument(aliasSync) }),
  };
}

// update the extension metadata
export function toForwarderMetadata(
  extension: ExtensionMetadata,
): GeneratorMetadata<ForwarderOptions> {
  if (extension.site.id !== "forwarder") {
    throw new Error(
      `expected forwarder extension; received ${extension.site.id} (${extension.product.vendor.id})`,
    );
  }

  const name = { literal: extension.product.name ?? extension.product.vendor.name };

  const generator: GeneratorMetadata<ForwarderOptions> = {
    id: { forwarder: extension.product.vendor.id },
    type: Type.email,
    weight: 300,
    i18nKeys: {
      name,
      description: "forwardedEmailDesc",
      generateCredential: "generateEmail",
      credentialGenerated: "emailGenerated",
      useCredential: "useThisEmail",
      credentialType: "email",
      copyCredential: "copyEmail",
    },
    capabilities: {
      autogenerate: false,
      fields: [...extension.requestedFields],
    },
    engine: {
      create(dependencies: GeneratorDependencyProvider) {
        const config = getForwarderConfiguration(extension.product.vendor.id);
        if (extension.product.vendor.id === Vendor.simplelogin) {
          return new SimpleLoginForwarder(config, dependencies.i18nService, dependencies.now);
        }
        return new Forwarder(config, dependencies.client, dependencies.i18nService);
      },
    },
    profiles: {
      [Profile.account]: {
        type: "extension",
        site: "forwarder",
        storage: {
          key: "forwarder",
          frame: 512,
          initial: {
            token: "",
            baseUrl: "",
            domain: "",
            prefix: "",
          },
          options: {
            deserializer: deserializeForwarderOptions,
            clearOn: ["logout"],
          },
        } satisfies ExtensionStorageKey<ForwarderOptions>,
        constraints: {
          default: {},
          create() {
            return new IdentityConstraint<ForwarderOptions>();
          },
        },
      } satisfies ForwarderProfileMetadata<ForwarderOptions>,
    },
  };

  return generator;
}
