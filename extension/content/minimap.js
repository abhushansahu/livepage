import { COLORS } from "../shared/colors.js";

/**
 * The shape of the article down the edge of the window.
 *
 * A long piece is hard to read partly because you cannot see it — you have no
 * idea whether the thing you want is above or below, or how much is left. This
 * is the scrollbar an IDE gives you: every marked passage as a tick at its own
 * depth, your own highlights solid and an agent's suggestions hollow, with the
 * part you have actually read shaded behind them.
 */

/**
 * Where each tick sits, as a percentage of the document.
 *
 * Pure so it can be reasoned about without a page: positions in, positions
 * out. Anything with no measurable place is dropped rather than stacked at
 * the top, for the same reason an unanchored card is.
 */
export function minimapTicks(items, docHeight) {
  const height = docHeight || 0;
  if (height <= 0) return [];
  return (items || [])
    .filter((item) => typeof item.top === "number" && item.top >= 0)
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      color: item.color,
      why: item.why || "",
      text: item.text || "",
      // Clamped, because a mark inside a fixed header can measure past the end.
      pct: Math.max(0, Math.min(100, (item.top / height) * 100))
    }))
    .sort((a, b) => a.pct - b.pct);
}

export function createMinimap() {
  const host = document.createElement("div");
  host.className = "lp-ignore lp-minimap";
  host.setAttribute("data-lp", "minimap");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${CSS}</style><div class="rail"><div class="read"></div><div class="here"></div></div>`;
  const rail = shadow.querySelector(".rail");
  const read = shadow.querySelector(".read");
  const here = shadow.querySelector(".here");
  let onJump = null;

  return {
    host,
    attach() {
      if (host.parentNode !== document.documentElement) {
        document.documentElement.appendChild(host);
      }
      // The margin cards read this and step aside, so the rail has its own
      // lane instead of sitting on their edge.
      document.documentElement.style.setProperty("--lp-minimap", "12px");
    },
    onJump(fn) {
      onJump = fn;
    },
    render(ticks) {
      rail.querySelectorAll(".tick").forEach((el) => el.remove());
      host.hidden = !ticks.length;
      if (!ticks.length) return;
      for (const tick of ticks) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = `tick is-${tick.kind}`;
        el.style.top = `${tick.pct}%`;
        el.style.setProperty("--lp-mark", COLORS[tick.color]?.fill || "#e8cf62");
        el.title = tick.why || tick.text.slice(0, 90);
        el.onclick = () => onJump?.(tick);
        rail.append(el);
      }
    },
    /** How far down you are, and how much you have actually been past. */
    setProgress({ percent = 0, maxPercent = 0 } = {}) {
      here.style.top = `${Math.max(0, Math.min(100, percent))}%`;
      read.style.height = `${Math.max(0, Math.min(100, maxPercent))}%`;
    },
    destroy() {
      document.documentElement.style.removeProperty("--lp-minimap");
      host.remove();
    }
  };
}

const CSS = `
:host { all: initial; }
.rail {
  position: fixed; top: 0; right: 0; bottom: 0; width: 12px;
  z-index: 2147483643; pointer-events: none;
}
.read {
  position: absolute; top: 0; left: 0; right: 0;
  background: color-mix(in srgb, #3f6b52 12%, transparent);
}
.here {
  position: absolute; left: 0; right: 0; height: 2px;
  background: color-mix(in srgb, #3f6b52 60%, transparent);
}
.tick {
  position: absolute; right: 2px; width: 8px; height: 4px;
  margin-top: -2px; padding: 0; border: 0; border-radius: 2px;
  background: var(--lp-mark); cursor: pointer; pointer-events: auto;
  transition: width 90ms ease, right 90ms ease;
}
.tick:hover, .tick:focus-visible { width: 12px; right: 0; outline: none; }
/* A suggestion is hollow; something you kept is solid. */
.tick.is-mark {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--lp-mark);
}
@media (prefers-reduced-motion: reduce) { .tick { transition: none; } }
`;
