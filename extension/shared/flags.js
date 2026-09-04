/**
 * Flag-based surfaces + one dashboard-density experiment.
 * Experiment supplies defaults; explicit settings.flags always win.
 */

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
  autoMarkup: true,
  minimap: true,
  dashboardLayout: "compact"
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
      }
    }
  }
};

export const DEFAULT_EXPERIMENT = {
  id: "dashboard-density",
  variant: "C"
};

export function resolveFlags(settings = {}) {
  const experiment = normalizeExperiment(settings.experiment);
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
    ...(settings.flags || {})
  };
  if (!["feed", "lists", "compact"].includes(flags.dashboardLayout)) {
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

function normalizeExperiment(value) {
  const id = value?.id && EXPERIMENTS[value.id] ? value.id : DEFAULT_EXPERIMENT.id;
  const variant = EXPERIMENTS[id].variants[value?.variant]
    ? value.variant
    : DEFAULT_EXPERIMENT.variant;
  return { id, variant };
}
