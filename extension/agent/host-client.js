export function agentHostUrl(settings) {
  return String(settings?.agentHostUrl || "http://127.0.0.1:17321").replace(/\/$/, "");
}

export async function pingAgentHost(settings) {
  try {
    const res = await fetch(`${agentHostUrl(settings)}/health`, {
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    return { ok: true, ...data };
  } catch {
    return { ok: false };
  }
}

export async function runAgentAsk({ settings, agent, model, packet, resumeId = "", cwd = "" }) {
  const chosen =
    model ||
    (agent === "claude-code" ? settings.claudeCodeModel : settings.cursorModel) ||
    "";
  const res = await fetch(`${agentHostUrl(settings)}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent,
      model: chosen,
      packet,
      resumeId: resumeId || "",
      cwd: cwd || settings.agentWorkspace || "",
      cursorPath: settings.cursorAgentPath || "",
      claudePath: settings.claudeCodePath || ""
    }),
    signal: AbortSignal.timeout(180000)
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Agent host HTTP ${res.status}. Run npm run agent-host in the LivePage repo.`);
  }
  if (!data.text) throw new Error("Agent returned an empty reply.");
  return {
    text: data.text,
    sessionId: data.sessionId || "",
    workspace: data.workspace || ""
  };
}
