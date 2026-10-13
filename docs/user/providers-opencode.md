# OpenCode

T3 Code uses the OpenCode setup on the connected environment. With a remote environment, its
OpenCode login and configuration apply, not the setup on your desktop or phone.

T3 Code supports OpenCode V1 from 1.14.19 and OpenCode V2 versions 2.0.18, 2.0.23, and 2.0.24.
V2 uses a separate API; a newer version number alone does not guarantee compatibility. T3 Code
checks the server version before it loads models or starts work. If the check fails, use a
supported OpenCode version or update T3 Code, then refresh the provider status. Reconnecting the
client also runs the check again.

## Server authentication

Without a server URL, T3 Code starts a local OpenCode server. The process inherits
`OPENCODE_SERVER_PASSWORD` from the environment. A password in the provider settings overrides
that environment value for both the local process and T3 Code.

With a server URL, T3 Code connects to that external server and uses only the password in the
provider settings. It does not send a local `OPENCODE_SERVER_PASSWORD` to an external server.
OpenCode uses this password for HTTP Basic authentication.

## Switch the OpenAI account

In **Settings > Providers**, choose the environment and its OpenCode provider. In **Configuration**,
use **OpenAI account** to see the active account, refresh the list, or choose another connected
account. Sign in through OpenCode first if the list is empty. Account switching requires an
administrative connection.

Account switching is available with an OpenCode V2 server. OpenCode V1 continues to work for chat,
but does not offer account switching. T3 Code does not add or remove OpenCode accounts.

The choice applies to the OpenCode server selected by that environment and affects every client
using that server. It does not pin an account to one thread. T3 Code blocks a change while that
OpenCode server is handling active work, including work started by another T3 client. Wait until it
is idle, then try again.

After a change, T3 Code reads the active account from OpenCode again and refreshes that provider's
model list. If a thread's saved model is no longer offered, T3 Code keeps the selection and marks it
unavailable; choose a model explicitly before continuing. Use **Refresh** in the account section to
check for changes made outside T3 Code.

## Refresh the model list

T3 Code loads the model list when an enabled OpenCode provider starts and keeps the list in its
cache. Reconnecting a client or using a refresh control asks OpenCode for the list again. The
periodic provider health setting does not refresh OpenCode's catalog.

After changing an OpenCode login or configuration outside T3 Code, open **Settings > Providers**,
select the environment, and choose **Refresh provider status**. Changing the provider's
configuration in T3 Code also replaces that provider connection.

On mobile, open the thread settings and select **Refresh models**. The control stays disabled while
the refresh runs and shows an error if the refresh fails.

OpenCode reads credential changes on each model-list request. Native OpenCode configuration files
can stay cached while the local helper is running. The helper closes after 30 seconds with no
model-list or text-generation work. Refresh after that idle period to start a new helper and read
the file changes. Repeated refreshes or active helper work can extend this wait.

T3 Code does not own an external OpenCode server. Native configuration changes on that server can
require its own reload or restart before a refresh returns the new list.

If a refresh fails, T3 Code keeps the last known models, slash commands, and skills. Fix the
connection, then refresh again. A successful refresh can remove entries that OpenCode no longer
offers.

## Continue an existing thread

An existing thread keeps its selected model and options when that model is temporarily absent
from the catalog. The web picker shows an **Unavailable** row and keeps saved option values visible
until the model metadata returns. T3 Code does not switch the thread to the first model in the
list.

The stored selection does not guarantee that OpenCode can still run the model. If the provider
rejects it, select an available model before trying again.
