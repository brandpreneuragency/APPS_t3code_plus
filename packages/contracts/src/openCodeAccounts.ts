import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

export const OpenCodeCredentialId = Schema.String.check(
  Schema.isMinLength(1),
).check(Schema.isMaxLength(512));

export const OpenCodeAccountSummary = Schema.Struct({
  credentialId: OpenCodeCredentialId,
  label: Schema.String.check(Schema.isMaxLength(120)),
  method: Schema.Literals(["key", "oauth"]),
});
export type OpenCodeAccountSummary = typeof OpenCodeAccountSummary.Type;

export const OpenCodeAccountState = Schema.Struct({
  support: Schema.Literals(["supported", "unsupported"]),
  accounts: Schema.Array(OpenCodeAccountSummary),
  /** Null with activeKnown=false means OpenCode could not confirm the active account. */
  activeCredentialId: Schema.NullOr(OpenCodeCredentialId),
  activeKnown: Schema.Boolean,
  busy: Schema.Boolean,
  detail: Schema.optional(Schema.String),
});
export type OpenCodeAccountState = typeof OpenCodeAccountState.Type;

export const OpenCodeAccountListInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type OpenCodeAccountListInput = typeof OpenCodeAccountListInput.Type;

export const OpenCodeAccountActivationInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  credentialId: OpenCodeCredentialId,
  /** If supplied, activation is rejected when the server-side active account has changed. */
  expectedActiveCredentialId: Schema.optional(Schema.NullOr(OpenCodeCredentialId)),
});
export type OpenCodeAccountActivationInput = typeof OpenCodeAccountActivationInput.Type;

export const OpenCodeAccountActivationResult = Schema.Struct({
  state: OpenCodeAccountState,
  activation: Schema.Literals(["activated", "unchanged", "unknown"]),
  catalogRefresh: Schema.Literals(["refreshed", "failed", "not-needed"]),
});
export type OpenCodeAccountActivationResult = typeof OpenCodeAccountActivationResult.Type;

export const OpenCodeAccountErrorReason = Schema.Literals([
  "unsupported",
  "busy",
  "account_not_found",
  "conflict",
  "unavailable",
]);
export type OpenCodeAccountErrorReason = typeof OpenCodeAccountErrorReason.Type;

export class OpenCodeAccountError extends Schema.TaggedErrorClass<OpenCodeAccountError>()(
  "OpenCodeAccountError",
  {
    instanceId: ProviderInstanceId,
    reason: OpenCodeAccountErrorReason,
    message: Schema.String,
  },
) {}
