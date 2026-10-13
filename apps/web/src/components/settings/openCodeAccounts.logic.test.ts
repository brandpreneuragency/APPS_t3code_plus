import {
  OpenCodeAccountError,
  ProviderInstanceId,
  type OpenCodeAccountState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canChangeOpenCodeAccount,
  getOpenCodeAccountFailureMessage,
  getOpenCodeAccountView,
} from "./openCodeAccounts.logic";

const supportedState = (overrides: Partial<OpenCodeAccountState> = {}): OpenCodeAccountState => ({
  support: "supported",
  accounts: [
    { credentialId: "credential-a", label: "OpenAI OAuth - 3fa2c1", method: "oauth" },
    { credentialId: "credential-b", label: "Work API key", method: "key" },
  ],
  activeCredentialId: "credential-a",
  activeKnown: true,
  busy: false,
  ...overrides,
});

describe("OpenCode account settings state", () => {
  it("distinguishes loading, unavailable, unsupported, empty, single, and multiple accounts", () => {
    expect(getOpenCodeAccountView(null, true)).toBe("loading");
    expect(getOpenCodeAccountView(null, false)).toBe("unavailable");
    expect(
      getOpenCodeAccountView(
        supportedState({ support: "unsupported", accounts: [], activeKnown: false }),
        false,
      ),
    ).toBe("unsupported");
    expect(getOpenCodeAccountView(supportedState({ accounts: [] }), false)).toBe("empty");
    expect(getOpenCodeAccountView(supportedState({ accounts: [{
      credentialId: "credential-a",
      label: "Personal OAuth",
      method: "oauth",
    }] }), false)).toBe("single");
    expect(getOpenCodeAccountView(supportedState(), false)).toBe("multiple");
  });

  it("does not enable selection when work, permissions, or state prevents a safe switch", () => {
    const base = {
      state: supportedState(),
      readOnly: false,
      canManage: true,
      switching: false,
    };
    expect(canChangeOpenCodeAccount(base)).toBe(true);
    expect(canChangeOpenCodeAccount({ ...base, readOnly: true })).toBe(false);
    expect(canChangeOpenCodeAccount({ ...base, canManage: false })).toBe(false);
    expect(canChangeOpenCodeAccount({ ...base, switching: true })).toBe(false);
    expect(canChangeOpenCodeAccount({ ...base, state: supportedState({ busy: true }) })).toBe(
      false,
    );
    expect(
      canChangeOpenCodeAccount({ ...base, state: supportedState({ activeKnown: false }) }),
    ).toBe(false);
    expect(canChangeOpenCodeAccount({ ...base, state: null })).toBe(false);
  });

  it("explains server busy responses and keeps other failures generic", () => {
    const busy = new OpenCodeAccountError({
      instanceId: ProviderInstanceId.make("opencode"),
      reason: "busy",
      message: "internal detail",
    });
    expect(getOpenCodeAccountFailureMessage(busy)).toContain("handling active work");
    expect(getOpenCodeAccountFailureMessage(new Error("secret or network detail"))).toContain(
      "permissions",
    );
    expect(getOpenCodeAccountFailureMessage(new Error("secret or network detail"))).not.toContain(
      "secret",
    );
  });
});
