# Hermes

Hermes uses the models and credentials configured on the connected environment.

Choose **Reasoning effort** beside the model in the composer to set the effort for
that session. **Default** uses your Hermes configuration, including model-specific
overrides. **None** requests disabled reasoning. The remaining choices come from
the installed Hermes version; their effect depends on the selected model and provider.

Changes apply to the next turn. Switching models preserves the selected effort.
Other sessions and your global Hermes settings are unaffected.

The reasoning picker requires a standard Hermes Python installation with the ACP
extra. If you use a custom launcher script, point the Hermes provider's binary path
at the Hermes executable inside its Python environment to enable the picker.

## Work details and interrupted sessions

Hermes reasoning appears as **Thinking** entries when the model supplies it.
Entries appear as reasoning blocks finish, before tool calls or response text.
Long blocks appear in smaller parts. Tool calls and their details appear in the
same work log. Expand **Worked for…** to inspect a completed turn.

If the provider connection fails, the next message reports the connection error
instead of waiting on a dead connection. Restarting the T3 server interrupts
running Hermes work. Send a new message to resume the saved conversation.
