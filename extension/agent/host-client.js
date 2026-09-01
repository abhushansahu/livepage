export function agentHostUrl(settings) {
  return String(settings?.agentHostUrl || "http://127.0.0.1:17321").replace(/\/$/, "");
}

export async function pairAgentHost(settings) {
  try {
    const res = await fetch(`${agentHostUrl(settings)}/pair`, {
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    const token = String(data?.token || "").trim();
    return token ? { ok: true, token } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export async function pingAgentHost(settings) {
  try {
    const res = await fetch(`${agentHostUrl(settings)}/health`, {
      headers: authHeaders(settings),
      signal: AbortSignal.timeout(2000)
    });
    if (res.status === 401) return { ok: false, status: 401 };
    if (!res.ok) return { ok: false };
    const data = await res.json();
    if (data.auth === false) return { ok: true, auth: false };
    return { ok: true, ...data };
  } catch {
    return { ok: false };
  }
}

export async function runAgentAsk({ settings, agent, model, packet, resumeId = "" }) {
  const chosen =
    model ||
    (agent === "claude-code" ? settings.claudeCodeModel : settings.cursorModel) ||
    "";
  const res = await fetch(`${agentHostUrl(settings)}/ask`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(settings)
    },
    body: JSON.stringify({
      agent,
      model: chosen,
      packet,
      resumeId: resumeId || ""
    }),
    signal: AbortSignal.timeout(180000)
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (res.status === 401) {
    throw new Error("Agent host rejected the request. Open Settings and tap Check host to pair again.");
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

function authHeaders(settings) {
  const token = String(settings?.agentHostToken || "").trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
