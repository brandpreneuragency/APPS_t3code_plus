import { OpenCodeAccountError, type OpenCodeAccountState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isOpenCodeAccountError = Schema.is(OpenCodeAccountError);

export type OpenCodeAccountView =
  | "loading"
  | "unavailable"
  | "unsupported"
  | "busy"
  | "unknown"
  | "empty"
  | "single"
  | "multiple";

export function getOpenCodeAccountView(
  state: OpenCodeAccountState | null,
  waiting: boolean,
): OpenCodeAccountView {
  if (state === null) return waiting ? "loading" : "unavailable";
  if (state.support === "unsupported") return "unsupported";
  if (state.busy) return "busy";
  if (!state.activeKnown) return "unknown";
  if (state.accounts.length === 0) return "empty";
  return state.accounts.length === 1 ? "single" : "multiple";
}

export function canChangeOpenCodeAccount(input: {
  readonly state: OpenCodeAccountState | null;
  readonly readOnly: boolean;
  readonly canManage: boolean;
  readonly switching: boolean;
}): boolean {
  return (
    input.state !== null &&
    input.state.support === "supported" &&
    input.state.activeKnown &&
    !input.state.busy &&
    input.state.accounts.length > 1 &&
    !input.readOnly &&
    input.canManage &&
    !input.switching
  );
}

export function getOpenCodeAccountFailureMessage(error: unknown): string {
  if (!isOpenCodeAccountError(error)) {
    return "Could not change the OpenAI account. Check this connection's permissions and try again.";
  }

  switch (error.reason) {
    case "busy":
      return "OpenCode is handling active work. Wait for it to finish, then try again.";
    case "conflict":
      return "The active OpenAI account changed. Refresh the list before choosing again.";
    case "account_not_found":
      return "That account is no longer connected to OpenCode. Refresh the list.";
    case "unsupported":
      return "This OpenCode server does not support account switching.";
    case "unavailable":
      return "OpenCode could not confirm the account change. Refresh to check its current state.";
  }
}
