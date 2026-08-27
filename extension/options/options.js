import { call } from "../shared/bridge.js";

const form = document.getElementById("form");
const status = document.getElementById("status");
const settings = await call("GET_SETTINGS");

for (const [key, value] of Object.entries(settings)) {
  const field = form.elements[key];
  if (!field) continue;
  if (field.type === "checkbox") field.checked = Boolean(value);
  else field.value = value ?? "";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const patch = {
    defaultColor: form.elements.defaultColor.value,
    agentDefault: form.elements.agentDefault.value,
    obsidianVault: form.elements.obsidianVault.value.trim(),
    obsidianFolder: form.elements.obsidianFolder.value.trim() || "LivePage",
    remindersEnabled: form.elements.remindersEnabled.checked,
    reminderHour: Number(form.elements.reminderHour.value || 9),
    lockInfiniteScroll: form.elements.lockInfiniteScroll.checked,
    importSavesEnabled: form.elements.importSavesEnabled.checked
  };
  await call("SAVE_SETTINGS", patch);
  chrome.runtime.sendMessage({ type: "RESCHEDULE_REMINDER" });
  status.hidden = false;
});
