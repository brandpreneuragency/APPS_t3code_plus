import {
  WS_METHODS,
  type OpenCodeAccountActivationInput,
  type OpenCodeAccountListInput,
} from "@t3tools/contracts";

import { request } from "../rpc/client.ts";

export const listOpenCodeAccounts = (input: OpenCodeAccountListInput) =>
  request(WS_METHODS.serverListOpenCodeAccounts, input);

export const activateOpenCodeAccount = (input: OpenCodeAccountActivationInput) =>
  request(WS_METHODS.serverActivateOpenCodeAccount, input);
