"""Exercise the T3 bridge against an installed Hermes ACP package without credentials or LLM calls."""
import json
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from acp.exceptions import RequestError
from acp.schema import SessionModelState, ModelInfo
from acp_adapter.server import HermesACPAgent
from acp_adapter.session import SessionState

bridge = {"__name__": "t3_hermes_bridge"}
exec(json.load(sys.stdin)["bridge"], bridge)
CONFIG = {"agent": {"reasoning_effort": "low"}}
with patch("hermes_cli.config.load_config", lambda: CONFIG):
    bridge["install_reasoning_bridge"]()


class ReasoningBridgeTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.states = {}

        def make_agent(**kwargs):
            return SimpleNamespace(provider="openrouter", reasoning_config=None, **kwargs)

        def create_session(cwd):
            session_id = f"fixture-{len(self.states)}"
            state = SessionState(session_id=session_id, agent=make_agent(), cwd=cwd, model="test-model")
            self.states[session_id] = state
            return state

        self.manager = Mock()
        self.manager.get_session.side_effect = self.states.get
        self.manager.create_session.side_effect = create_session
        self.manager.update_cwd.side_effect = lambda session_id, cwd: self.states.get(session_id)
        self.manager.fork_session.side_effect = lambda session_id, cwd: create_session(cwd)
        self.manager._make_agent.side_effect = make_agent
        self.agent = HermesACPAgent(session_manager=self.manager)
        self.agent._register_session_mcp_servers = AsyncMock()
        self.agent._replay_session_history = AsyncMock()
        self.agent._schedule_available_commands_update = Mock()
        self.agent._schedule_usage_update = Mock()
        self.agent._build_model_state = lambda state: SessionModelState(
            current_model_id=state.model,
            available_models=[ModelInfo(model_id=state.model, name=state.model)],
        )
        self.agent._resolve_model_selection = lambda model, provider: (provider, model)

    async def new(self):
        response = await self.agent.new_session(cwd="/disposable")
        return self.states[response.session_id], response

    async def effort(self, state, value):
        return await self.agent.set_config_option("t3:reasoning-effort", state.session_id, value)

    async def test_discovery_advertises_configured_levels_and_preserves_models(self):
        state, response = await self.new()
        wire = response.model_dump(by_alias=True)
        self.assertEqual(wire["models"]["currentModelId"], "test-model")
        option = wire["configOptions"][0]
        self.assertEqual(option["currentValue"], "default")
        self.assertTrue({"default", "none", "low", "high"}.issubset({o["value"] for o in option["options"]}))
        self.assertEqual(state.agent.reasoning_config, {"enabled": True, "effort": "low"})

    async def test_high_none_and_default_change_the_underlying_agent(self):
        state, _ = await self.new()
        for value, expected in [
            ("high", {"enabled": True, "effort": "high"}),
            ("none", {"enabled": False}),
            ("default", {"enabled": True, "effort": "low"}),
        ]:
            response = await self.effort(state, value)
            self.assertEqual(state.agent.reasoning_config, expected)
            self.assertEqual(response.model_dump(by_alias=True)["configOptions"][0]["currentValue"], value)

    async def test_sessions_are_independent_and_config_is_not_written(self):
        first, _ = await self.new()
        second, _ = await self.new()
        self.manager.save_session.reset_mock()
        await self.effort(first, "high")
        self.assertEqual(second.agent.reasoning_config, {"enabled": True, "effort": "low"})
        self.assertEqual(CONFIG, {"agent": {"reasoning_effort": "low"}})
        self.manager.save_session.assert_not_called()

    async def test_invalid_value_is_rejected_without_mutation(self):
        state, _ = await self.new()
        with self.assertRaises(RequestError):
            await self.effort(state, "invalid")
        self.assertEqual(state.agent.reasoning_config, {"enabled": True, "effort": "low"})

    async def test_unknown_session_is_rejected(self):
        with self.assertRaises(RequestError):
            await self.agent.set_config_option("t3:reasoning-effort", "missing", "high")

    async def test_active_turn_rejects_changes_but_allows_same_selection(self):
        state, _ = await self.new()
        await self.effort(state, "high")
        state.is_running = True
        await self.effort(state, "high")
        with self.assertRaises(RequestError):
            await self.effort(state, "none")
        self.assertEqual(state.agent.reasoning_config["effort"], "high")

    async def test_model_switch_keeps_the_effort_on_the_rebuilt_agent(self):
        state, _ = await self.new()
        await self.effort(state, "high")
        original = state.agent
        await self.agent.set_session_model("other-model", state.session_id)
        self.assertIsNot(state.agent, original)
        self.assertEqual(state.agent.reasoning_config, {"enabled": True, "effort": "high"})

    async def test_active_turn_rejects_model_rebuild(self):
        state, _ = await self.new()
        state.is_running = True
        with self.assertRaises(RequestError):
            await self.agent.set_session_model("other-model", state.session_id)
        self.manager._make_agent.assert_not_called()

    async def test_load_resume_and_fork_advertise_reasoning(self):
        state, _ = await self.new()
        await self.effort(state, "high")
        for name in ("load_session", "resume_session", "fork_session"):
            response = await getattr(self.agent, name)(cwd=state.cwd, session_id=state.session_id)
            self.assertEqual(response.model_dump(by_alias=True)["configOptions"][0]["id"], "t3:reasoning-effort")

    async def test_other_config_options_keep_native_behavior(self):
        state, _ = await self.new()
        await self.agent.set_config_option("unrelated", state.session_id, "value")
        self.assertEqual(state.config_options["unrelated"], "value")
        self.assertEqual(state.agent.reasoning_config["effort"], "low")


unittest.main(argv=["hermesReasoningProbe"], verbosity=2)
