"""A team agent for the Okta Agent Gateway demo, hosted on Amazon Bedrock AgentCore Runtime.

The same code runs as the Engineering, Sales and HR agent: TEAM_NAME, TEAM_BRIEF and GATEWAY_URL decide which.
The agent never holds credentials of its own. The caller's Okta access token arrives in the Authorization header (AgentCore has
already verified it against the team's Okta authorization server), and this code forwards it, unchanged, to the team's
gateway. Okta then decides which tools exist for this person and mints the downstream tokens. Claude only chooses which of the
tools the gateway lists to call.
"""
import os
import json
import uuid
import logging
from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from strands import Agent, tool
from strands.models import BedrockModel
from strands.tools.mcp import MCPClient
from strands.tools.mcp._compat import streamable_http_transport  # works on both major lines of the mcp package

log = logging.getLogger("team-agent")
app = BedrockAgentCoreApp()

TEAM_NAME = os.environ.get("TEAM_NAME", "Sales")
TEAM_BRIEF = os.environ.get("TEAM_BRIEF", "You help the team with its day-to-day questions.")
GATEWAY_URL = os.environ.get("GATEWAY_URL", "")
MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-haiku-5-5")
REGION = os.environ.get("AWS_REGION", "us-east-1")
# Real tools that belong to other teams' gateways. This agent is NOT given them; it only knows their names (see try_other_tool).
OTHER_TOOLS = [t.strip() for t in os.environ.get("OTHER_TOOLS", "").split(",") if t.strip()]

SYSTEM_PROMPT = f"""You are the {TEAM_NAME} team's AI agent at a fictional company. {TEAM_BRIEF}
You act on behalf of the signed-in person, using only the tools you have been given. Rules:
- Use the tools to answer; never invent customer, employee or repository data.
- If you have no tool for something, or a tool is refused, say so plainly in one sentence and say what you can do instead. Do not try to work around a refusal.
- If a tool result says a connection or consent is required, relay that message and the link exactly.
- Keep answers short: a sentence or two, then a compact list or table if it helps."""
if OTHER_TOOLS:
    SYSTEM_PROMPT += f"""
- Other teams have tools you were not given: {', '.join(OTHER_TOOLS)}. Access is decided by the company's identity platform, not by you.
  If the person asks for something only one of those tools could do (for example another team's data), do not refuse on your own:
  call try_other_tool with that tool's exact name so the platform can decide, then report the outcome honestly and briefly.
  Never use try_other_tool for anything your own tools can do."""

# Conversation memory per AgentCore session. The platform keeps the same container for a session, so a dict is enough for a demo.
_sessions: dict[str, list] = {}


def _blocks(message):
    c = message.get("content") if isinstance(message, dict) else None
    return c if isinstance(c, list) else []


def _tool_text(result):
    parts = [b.get("text", "") for b in result.get("content", []) if isinstance(b, dict) and "text" in b]
    return "\n".join(p for p in parts if p)


def make_try_other_tool(gateway):
    @tool
    def try_other_tool(tool_name: str, arguments: dict | None = None) -> str:
        """Attempt a tool that is not in your own list, by its exact name, so the identity platform decides whether it is allowed.

        Args:
            tool_name: The exact name of the other team's tool, for example HRMCP_get_compensation.
            arguments: The tool's arguments, if you know them (an empty object is fine).
        """
        try:
            res = gateway.call_tool_sync(tool_use_id=f"try-{uuid.uuid4().hex[:12]}", name=tool_name, arguments=arguments or {})
        except Exception as e:  # the gateway answers an unlisted tool with an MCP error
            raise RuntimeError(f"GATEWAY_REFUSED: {type(e).__name__}: {str(e)[:300]}")
        text = " ".join(c.get("text", "") for c in res.get("content", []) if isinstance(c, dict))
        if res.get("status") == "error":
            raise RuntimeError(f"GATEWAY_REFUSED: {text[:300]}")
        return text
    return try_other_tool


@app.entrypoint
async def invoke(payload, context: RequestContext):
    prompt = (payload or {}).get("prompt", "")
    if not isinstance(prompt, str) or not prompt.strip():
        yield {"type": "error", "message": "Send {\"prompt\": \"...\"}."}
        return
    token = (context.request_headers or {}).get("Authorization") or (context.request_headers or {}).get("authorization")
    if not token:
        yield {"type": "error", "message": "No Authorization header reached the agent: the runtime's header allowlist must include Authorization."}
        return
    if not GATEWAY_URL:
        yield {"type": "error", "message": "GATEWAY_URL is not configured for this agent."}
        return
    session_id = getattr(context, "session_id", None) or "default"

    # The caller's own token goes to the gateway untouched: this is the whole point of the demo.
    gateway = MCPClient(lambda: streamable_http_transport(GATEWAY_URL, headers={"Authorization": token}))
    try:
        with gateway:
            tools = gateway.list_tools_sync()
            yield {"type": "tools", "tools": [t.tool_name for t in tools]}
            agent = Agent(
                model=BedrockModel(model_id=MODEL_ID, region_name=REGION),
                tools=[*tools, *( [make_try_other_tool(gateway)] if OTHER_TOOLS else [] )], system_prompt=SYSTEM_PROMPT, messages=list(_sessions.get(session_id, [])), callback_handler=None,
            )
            seen_calls, seen_results = set(), set()
            async for ev in agent.stream_async(prompt):
                if "data" in ev and isinstance(ev["data"], str):
                    yield {"type": "text", "text": ev["data"]}
                msg = ev.get("message")
                if isinstance(msg, dict):
                    for b in _blocks(msg):
                        if "toolUse" in b and b["toolUse"].get("toolUseId") not in seen_calls:
                            seen_calls.add(b["toolUse"]["toolUseId"])
                            yield {"type": "tool_call", "id": b["toolUse"]["toolUseId"], "name": b["toolUse"]["name"], "input": b["toolUse"].get("input", {})}
                        if "toolResult" in b and b["toolResult"].get("toolUseId") not in seen_results:
                            r = b["toolResult"]
                            seen_results.add(r.get("toolUseId"))
                            yield {"type": "tool_result", "id": r.get("toolUseId"), "status": r.get("status", "success"), "text": _tool_text(r)[:4000]}
            _sessions[session_id] = list(agent.messages)[-40:]
            yield {"type": "done"}
    except Exception as e:  # surface the reason to the caller instead of a bare 500
        log.exception("agent failed")
        yield {"type": "error", "message": f"{type(e).__name__}: {str(e)[:400]}"}


if __name__ == "__main__":
    app.run()
