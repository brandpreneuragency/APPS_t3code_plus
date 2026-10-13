import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OpenCodeAccountState, ProviderInstanceId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  canChangeOpenCodeAccount,
  getOpenCodeAccountFailureMessage,
  getOpenCodeAccountView,
} from "./openCodeAccounts.logic";

export function OpenCodeAccountSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly readOnly: boolean;
  readonly canManage: boolean;
}) {
  const query = serverEnvironment.openCodeAccounts({
    environmentId: props.environmentId,
    input: { instanceId: props.instanceId },
  });
  const queryResult = useAtomValue(query);
  const queriedState = Option.getOrNull(AsyncResult.value(queryResult));
  const [confirmedState, setConfirmedState] = useState<OpenCodeAccountState | null>(null);
  const [switching, setSwitching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const activateAccount = useAtomCommand(serverEnvironment.activateOpenCodeAccount, {
    reportFailure: false,
  });
  const state = confirmedState ?? queriedState;
  const view = getOpenCodeAccountView(state, queryResult.waiting);
  const disabled = !canChangeOpenCodeAccount({
    state,
    readOnly: props.readOnly,
    canManage: props.canManage,
    switching,
  });

  const refresh = () => {
    setConfirmedState(null);
    setNotice(null);
    appAtomRegistry.refresh(query);
  };

  const activate = async (credentialId: string | null) => {
    if (!credentialId || !state || disabled || credentialId === state.activeCredentialId) return;
    setSwitching(true);
    setNotice(null);
    try {
      const result = await activateAccount({
        environmentId: props.environmentId,
        input: {
          instanceId: props.instanceId,
          credentialId,
          expectedActiveCredentialId: state.activeCredentialId,
        },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        setConfirmedState(null);
        setNotice(getOpenCodeAccountFailureMessage(error));
        appAtomRegistry.refresh(query);
        return;
      }

      setConfirmedState(result.value.state);
      if (result.value.activation === "unknown") {
        setNotice("OpenCode could not confirm which account is active. Refresh before continuing.");
      } else if (result.value.catalogRefresh === "failed") {
        setNotice("The account changed, but OpenCode's model list could not be refreshed.");
      }
    } catch (error) {
      setConfirmedState(null);
      setNotice(getOpenCodeAccountFailureMessage(error));
      appAtomRegistry.refresh(query);
    } finally {
      setSwitching(false);
    }
  };

  const selectedLabel = state?.activeKnown
    ? (state.accounts.find((account) => account.credentialId === state.activeCredentialId)?.label ??
      (state.activeCredentialId === null ? "No active account" : "Active account not listed"))
    : "Active account unknown";

  return (
    <section className="grid gap-2 rounded-md border border-border/60 bg-muted/15 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">OpenAI account</span>
        <Button
          type="button"
          size="icon-micro"
          variant="ghost-muted"
          disabled={switching || queryResult.waiting}
          onClick={refresh}
          aria-label="Refresh OpenAI account"
        >
          {switching || queryResult.waiting ? (
            <LoaderIcon className="size-3 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3" />
          )}
        </Button>
      </div>

      {view === "loading" ? (
        <p className="text-xs text-muted-foreground">Loading OpenAI account state...</p>
      ) : view === "unavailable" ? (
        <p className="text-xs text-muted-foreground">Could not read OpenCode account state. Refresh to try again.</p>
      ) : view === "unsupported" ? (
        <p className="text-xs text-muted-foreground">
          {state?.detail ?? "Account switching requires an OpenCode V2 server. OpenCode V1 chat remains available."}
        </p>
      ) : view === "empty" ? (
        <p className="text-xs text-muted-foreground">
          No OpenAI credential accounts are configured in OpenCode. Sign in to OpenAI in OpenCode, then refresh.
        </p>
      ) : (
        <>
          {state && state.accounts.length > 1 ? (
            <Select value={state.activeKnown ? state.activeCredentialId : null} onValueChange={activate}>
              <SelectTrigger
                size="compact"
                className="w-full"
                disabled={disabled}
                aria-label="Active OpenAI account"
              >
                <SelectValue placeholder={selectedLabel} />
              </SelectTrigger>
              <SelectPopup>
                {state.accounts.map((account) => (
                  <SelectItem key={account.credentialId} value={account.credentialId}>
                    {account.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : state && state.accounts.length === 1 ? (
            <p className="text-sm text-foreground">{selectedLabel}</p>
          ) : null}

          {view === "busy" ? (
            <p className="text-xs text-muted-foreground">
              OpenCode is handling active work. Account switching is unavailable until it is idle.
            </p>
          ) : view === "unknown" ? (
            <p className="text-xs text-muted-foreground">
              OpenCode could not confirm the active account. Refresh to check its current state.
            </p>
          ) : view === "single" ? (
            <p className="text-xs text-muted-foreground">Only one OpenAI account is connected.</p>
          ) : view === "multiple" && !props.canManage ? (
            <p className="text-xs text-muted-foreground">
              Administrative access is required to change the account.
            </p>
          ) : null}
        </>
      )}

      <p className="text-xs text-muted-foreground">
        This changes the account for this OpenCode server for all its clients; it does not pin an account to a chat.
      </p>
      {notice ? (
        <p role="status" className="text-xs text-warning">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
