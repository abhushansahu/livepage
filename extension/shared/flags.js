/**
 * Flag-based surfaces + one dashboard-density experiment.
 * Experiment supplies defaults; explicit settings.flags always win.
 */

export const DASHBOARD_LAYOUTS = ["feed", "lists", "compact", "home"];

export const FLAG_DEFAULTS = {
  forYouFeed: true,
  readingList: true,
  bookmarks: true,
  saves: true,
  review: true,
  rss: true,
  localTweets: false,
  importSaves: true,
  articleSymbols: false,
  orphanRecovery: true,
  markup: true,
  minimap: true,
  dashboardLayout: "home"
};

export const EXPERIMENTS = {
  "dashboard-density": {
    id: "dashboard-density",
    name: "Dashboard density",
    blurb: "How much the home surface should show at once.",
    variants: {
      A: {
        label: "A · feed",
        hint: "For you as a timeline. Local observations stay off unless you turn them on.",
        flags: {
          forYouFeed: true,
          dashboardLayout: "feed",
          localTweets: false
        }
      },
      B: {
        label: "B · lists",
        hint: "Skip the timeline. Start in lists so sources stay in their own rooms.",
        flags: {
          forYouFeed: false,
          dashboardLayout: "lists",
          localTweets: false
        }
      },
      C: {
        label: "C · portal",
        hint: "Rooms and tags on the left, the list in the middle, what is waiting on the right.",
        flags: {
          forYouFeed: true,
          dashboardLayout: "compact",
          localTweets: false
        }
      },
      D: {
        label: "D · home",
        hint: "One calm column: what you were mid-way through, what is waiting, and the rooms as tabs.",
        flags: {
          forYouFeed: true,
          dashboardLayout: "home",
          localTweets: false
        }
      }
    }
  }
};

export const DEFAULT_EXPERIMENT = {
  id: "dashboard-density",
  variant: "D"
};

export function resolveFlags(settings = {}) {
  const migrated = migrateExperiment(settings);
  const experiment = normalizeExperiment(migrated.experiment);
  const variantFlags =
    EXPERIMENTS[experiment.id]?.variants?.[experiment.variant]?.flags || {};
  const legacy = {};
  if (typeof settings.localTweetsEnabled === "boolean") {
    legacy.localTweets = settings.localTweetsEnabled;
  }
  if (typeof settings.importSavesEnabled === "boolean") {
    legacy.importSaves = settings.importSavesEnabled;
  }
  const flags = {
    ...FLAG_DEFAULTS,
    ...variantFlags,
    ...legacy,
    ...(migrated.flags || {})
  };
  if (!DASHBOARD_LAYOUTS.includes(flags.dashboardLayout)) {
    flags.dashboardLayout = FLAG_DEFAULTS.dashboardLayout;
  }
  return { flags, experiment };
}

export function experimentMeta(experiment = DEFAULT_EXPERIMENT) {
  const spec = EXPERIMENTS[experiment.id];
  const variant = spec?.variants?.[experiment.variant];
  return {
    id: experiment.id,
    variant: experiment.variant,
    name: spec?.name || experiment.id,
    label: variant?.label || experiment.variant,
    hint: variant?.hint || spec?.blurb || ""
  };
}

export function navItems(flags = FLAG_DEFAULTS) {
  return [
    { id: "home", label: "For you", flag: "forYouFeed" },
    { id: "reading", label: "Reading list", flag: "readingList" },
    { id: "bookmarked", label: "Bookmarks", flag: "bookmarks" },
    { id: "saves", label: "Saves", flag: "saves" },
    { id: "rss", label: "RSS", flag: "rss" },
    { id: "review", label: "Review", flag: "review" }
  ].filter((item) => flags[item.flag] !== false);
}

export function firstVisibleFilter(flags = FLAG_DEFAULTS, preferred = "home") {
  const items = navItems(flags);
  if (items.some((item) => item.id === preferred)) return preferred;
  return items[0]?.id || "reading";
}

/**
 * "C · portal" was the install default before "D · home" existed, so every
 * older profile carries it whether or not anyone picked it. Settings marks a
 * variant it saved with `chosen`; a C without that mark is the old default,
 * and moves to the new one together with the layout the old default wrote.
 */
function migrateExperiment(settings) {
  const experiment = settings.experiment;
  if (!experiment || experiment.variant !== "C" || experiment.chosen) return settings;
  const flags = { ...(settings.flags || {}) };
  if (flags.dashboardLayout === "compact") delete flags.dashboardLayout;
  return { ...settings, experiment: { ...experiment, variant: "D" }, flags };
}

function normalizeExperiment(value) {
  const id = value?.id && EXPERIMENTS[value.id] ? value.id : DEFAULT_EXPERIMENT.id;
  const variant = EXPERIMENTS[id].variants[value?.variant]
    ? value.variant
    : DEFAULT_EXPERIMENT.variant;
  return { id, variant };
}
