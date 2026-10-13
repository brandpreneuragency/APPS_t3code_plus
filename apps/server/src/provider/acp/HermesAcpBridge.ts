/** Loaded only in T3's Hermes subprocess. The installed Hermes files and config remain untouched. */
export const HERMES_ACP_REASONING_BRIDGE = String.raw`
import functools
import inspect
import sys

def install_reasoning_bridge():
    from acp.exceptions import RequestError
    from acp.schema import SetSessionConfigOptionResponse
    from acp_adapter.server import HermesACPAgent
    from hermes_cli.config import load_config
    from hermes_constants import VALID_REASONING_EFFORTS, parse_reasoning_effort, resolve_reasoning_config

    config_id = "t3:reasoning-effort"
    values = ["default", "none", *VALID_REASONING_EFFORTS]

    def option(state):
        return {
            "id": config_id,
            "name": "Reasoning effort",
            "category": "thought_level",
            "type": "select",
            "currentValue": getattr(state, "_t3_reasoning_effort", "default"),
            "options": [
                {"value": value, "name": "Default" if value == "default" else value.capitalize()}
                for value in values
            ],
        }

    def apply(state, value):
        state.agent.reasoning_config = (
            resolve_reasoning_config(load_config(), state.model)
            if value == "default" else parse_reasoning_effort(value)
        )
        state._t3_reasoning_effort = value

    def advertise(original):
        @functools.wraps(original)
        async def wrapped(self, *args, **kwargs):
            response = await original(self, *args, **kwargs)
            if response is None:
                return response
            session_id = getattr(response, "session_id", None)
            if session_id is None:
                session_id = inspect.signature(original).bind(self, *args, **kwargs).arguments.get("session_id")
            state = self.session_manager.get_session(session_id)
            if state is not None:
                # Hermes versions predating the ACP config fix also need the configured default applied.
                apply(state, getattr(state, "_t3_reasoning_effort", "default"))
                options = list(getattr(response, "config_options", None) or [])
                state._t3_native_config_options = options
                response = type(response).model_validate({
                    **response.model_dump(by_alias=True), "configOptions": [*options, option(state)]
                })
            return response
        return wrapped

    for name in ("new_session", "load_session", "resume_session", "fork_session"):
        original = getattr(HermesACPAgent, name, None)
        if original is not None:
            setattr(HermesACPAgent, name, advertise(original))

    original_set_config = HermesACPAgent.set_config_option

    async def set_config(self, config_id, session_id, value, **kwargs):
        if config_id != "t3:reasoning-effort":
            return await original_set_config(self, config_id, session_id, value, **kwargs)
        if value not in values:
            raise RequestError.invalid_params({"details": "Unsupported Hermes reasoning effort"})
        state = self.session_manager.get_session(session_id)
        if state is None:
            raise RequestError.invalid_params({"details": "Unknown Hermes session"})
        with state.runtime_lock:
            if value != getattr(state, "_t3_reasoning_effort", "default"):
                if state.is_running or getattr(state, "command_op", False):
                    raise RequestError(-32603, "Change reasoning effort while the Hermes session is idle")
                apply(state, value)
        return SetSessionConfigOptionResponse.model_validate({
            "configOptions": [*getattr(state, "_t3_native_config_options", []), option(state)]
        })

    HermesACPAgent.set_config_option = set_config
    original_set_model = HermesACPAgent.set_session_model

    @functools.wraps(original_set_model)
    async def set_model(self, model_id, session_id, **kwargs):
        state = self.session_manager.get_session(session_id)
        if state is not None:
            with state.runtime_lock:
                if state.is_running or getattr(state, "command_op", False):
                    raise RequestError(-32603, "Change models while the Hermes session is idle")
        response = await original_set_model(self, model_id, session_id, **kwargs)
        state = self.session_manager.get_session(session_id)
        if state is not None and response is not None:
            apply(state, getattr(state, "_t3_reasoning_effort", "default"))
        return response

    HermesACPAgent.set_session_model = set_model

if __name__ == "__main__":
    install_reasoning_bridge()
    from hermes_cli.main import main
    sys.argv = ["hermes", "acp"]
    main()
`;
