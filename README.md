# LivePage

A Chrome extension that turns any live webpage into a writable thinking surface: colored highlights, margin conversations, forked threads with Cursor Agent or Claude Code, a dashboard of waiting pages, and an Obsidian vault dump.

The philosophy lives in [`docs/intention.md`](docs/intention.md). This is **0.2.0**: a working Chrome extension you load unpacked, not a sketch.

## Install

Load the unpacked extension into **the Chrome you already use**. That profile is already signed into X, Reddit, and YouTube. LivePage harvests those sessions. There is no dedicated LivePage browser, and no second login.

1. Clone this repo (or pull if you already have it).
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. **Load unpacked** → select the `extension/` folder.
5. Pin LivePage.

```bash
git clone https://github.com/abhushansahu/livepage
cd livepage
```

Reload the extension after `git pull`.

Homebrew cannot inject an extension into your existing Chrome profile, so there is no brew formula. If a `livepage` command is still on your PATH from an earlier experiment, you can ignore or delete it.

## Local demo habitat

Optional. Serves the fixture pages and the dashboard over HTTP so you can try the UI without packing. For in-thread agent replies, keep the host running too:

```bash
npm test
npm run demo
npm run agent-host
```

Then open:

- [http://127.0.0.1:4173/demo/article.html](http://127.0.0.1:4173/demo/article.html)
- [http://127.0.0.1:4173/extension/dashboard/index.html](http://127.0.0.1:4173/extension/dashboard/index.html)

The HTTP dashboard seeds a trail. The real extension uses its own IndexedDB inside your Chrome profile.

## Try for a few days

1. Browse in your normal Chrome. Highlight and comment on the live page.
2. Scroll articles — reading status is how far you actually got, not a clip checkbox.
3. Open X bookmarks, Reddit saved, or YouTube Watch Later once (or tap **Refresh from this Chrome**). Stay logged in as usual; do not create a second account for LivePage.
4. Add RSS from Settings, or from a page that advertises a feed. Tag the feed. Tags copy onto items.
5. Star bookmarks as you go. They are meant to live a long time. Tags, search (`#tag`), and sort (oldest unread / never opened) are how you find them later.
6. Bind your Obsidian vault folder (a git repo) from the dashboard. **Write vault** dumps open markdown + `catalog.json`. `git pull` / `git push` keeps two machines in sync. Chrome cannot push for you.
7. If the dashboard gets loud, open Settings → Experiments. Switch A (feed) / B (lists), or turn individual surfaces off.

## What it does

**On the page.** Select a span. A quiet toolbar offers six highlight colors and a comment. Highlights restore when you return. Comments live **inline in a reserved right margin**, aligned to the span — Google Docs / Notion style — not a floating overlay. Click a highlight or its margin card to expand the thread in place.

**Threads can fork.** Any message can branch. You and an agent can take different readings of the same span without overwriting each other.

**Agents get a parsed packet, not a second copy of the page.** **Ask Cursor** / **Ask Claude Code** builds a markdown packet that:

- states a contract: answer **strictly** the user’s ask
- includes only **new unique content blocks** (already-sent blocks are omitted)
- includes the anchored quote and the thread so far

Keep `npm run agent-host` running in this repo. The extension calls the Cursor Agent CLI (`agent`) or Claude Code CLI (`claude`) on this machine — no API keys — and writes the reply into the thread. If the host is down, the packet is still there to copy, and you can paste a reply back by hand.

**Infinite-scroll pages snapshot themselves.** Feeds (or pages that keep growing) cannot keep stable anchors against a moving DOM, so LivePage snapshots the current view the moment you make a highlight there. There is no prompt and no banner — you highlight, and the snapshot happens underneath. Known hosts include X, Reddit, LinkedIn, Instagram, TikTok, YouTube, Facebook, and HN.

**Nothing is stored just because you opened it.** LivePage writes a record the first time you *keep* a page — highlight, comment, star, add to the reading list, tag, or import it. Reading a page and closing it leaves no trace. This is deliberate: you open hundreds of pages a day, and counting them would bury the feed and make every derived number meaningless, since "never opened" and "% read through" are only worth reading against pages you meant to come back to. Scroll depth on an unkept page is held in memory, so a highlight made at 60% still records 60%. Settings has a **Forget browsed-only pages** button for records left by earlier builds.

**Dashboard.** Home can be a **For you** feed or a quieter list, depending on the experiment flag. Untouched Watch Later, X bookmarks, Reddit saves, RSS, half-read pages, and comments still waiting keep coming back. Reading status is still **scroll depth**. Local observations are **off by default**. Lists (reading / bookmarks / saves / RSS / review) can be hidden independently so the board does not become every inbox at once.

**Pulled saves.** While this Chrome is logged in, LivePage harvests X bookmarks, Reddit saved, YouTube Watch Later, Pocket, and HN favorites. It does not ask you to sign in again. X bookmarks are pulled when you open that page (or tap **Refresh from this Chrome**). They land as unread bookmarks until you actually open the live page.

**Tags.** Every page carries user tags plus derived tags (`youtube`, `bookmark`, `user-comment`, `ai-comment`, feed names, …). The dashboard filters and sorts on that shared vocabulary. Search `#tag` works too.

**RSS.** Settings holds tagged feeds. On a site that exposes `<link rel="alternate" type="application/rss+xml">`, LivePage offers **Add feed**. Right-click → **LivePage: add RSS feed from this page**.

**Bookmarks.** The star is independent of reading progress. They are not meant to expire. The problem they usually have is retrieval: tags, oldest-unread sort, and feed copy like “Bookmarked 21 days ago · #questions · never opened.”

**Obsidian / git vault.** Dump is not only `obsidian://new`. Bind the vault folder (the git checkout). LivePage writes:

```
livepage/README.md
livepage/index.md          # map of content
livepage/catalog.json      # machine index
livepage/config.json       # RSS + flags snapshot
livepage/tags.md
livepage/pages/*.md        # YAML frontmatter notes
```

That layout is ordinary files. You, an agent, or a second laptop can walk the repo. GitHub is the sync bus. Fallback if you skip the bind: download `.md` + `obsidian://new`.

**Feature flags / A-B.** Settings → Experiments. Variant A is feed-first. Variant B hides For you and starts in lists. Individual rooms (For you, reading list, bookmarks, saves, RSS, review, local observations, harvest) can be toggled. This is how we keep the dashboard from becoming every source at once while we learn what actually helps.

## Shortcuts

| Action | Default |
| --- | --- |
| Highlight selection | `Alt+H` |
| Comment on selection | `Alt+M` |
| Open dashboard | `Alt+Shift+L` |

Right-click a selection for the same actions. Right-click a page to add its RSS feed.

## Tests

```bash
npm test
```

## Limits (honest)

- This is an extension, not a research browser. It cannot rewrite navigation the way Horse Trails does.
- Agent replies go through a **local host** (`npm run agent-host`) that shells out to CLIs already on this machine. There is no cloud LivePage API. If the host is down, you still have the packet and paste-back.
- Highlights use text-quote selectors. If a page rewrites the paragraph, the mark may not restore.
- Chrome cannot `git push`. The vault dump is files; sync is your git (or Obsidian Git).
- Very large `obsidian://` URIs can fail; the bound folder or downloaded markdown is the reliable copy.
- Harvest uses the cookies of **this** Chrome profile. If you are not logged into X in this profile, LivePage cannot invent that session.
