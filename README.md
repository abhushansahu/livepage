# LivePage

A Chrome extension that turns any live webpage into a writable thinking surface: colored highlights, margin conversations, forked threads with Cursor Agent or Claude Code, a dashboard of waiting pages, and an Obsidian dump.

The philosophy lives in [`docs/intention.md`](docs/intention.md). This folder is the first build.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` directory
4. Pin LivePage. Visit any article. Select text.

Demo pages (optional):

```bash
npm run demo
```

Then open `http://127.0.0.1:4173/demo/article.html` and `http://127.0.0.1:4173/demo/feed.html`. The demo pages can run LivePage without installing the extension, so you can try the habitat immediately. Load unpacked from `extension/` to use it on the real web.

## What it does

**On the page.** Select a span. A quiet toolbar offers six highlight colors and a comment. Highlights restore when you return. Comments live **inline in a reserved right margin**, aligned to the span — Google Docs / Notion style — not a floating overlay. Click a highlight or its margin card to expand the thread in place.

**Threads can fork.** Any message can branch. You and an agent can take different readings of the same span without overwriting each other.

**Agents get a parsed packet, not a second copy of the page.** “Send to Cursor” / “Send to Claude Code” copies a markdown packet that:

- states a contract: answer **strictly** the user’s ask
- includes only **new unique content blocks** (already-sent blocks are omitted)
- includes the anchored quote and the thread so far

Paste that packet into Cursor Agent or Claude Code. Paste the reply into the same composer and send — it is stored as the agent’s turn.

**Infinite-scroll pages are locked.** Feeds (or pages that keep growing) cannot keep stable anchors. LivePage blocks highlighting until you **snapshot** the current view. Known hosts include X, Reddit, LinkedIn, Instagram, TikTok, YouTube, Facebook, and HN.

**Dashboard.** Waiting pages, bookmarks, and parsed blocks, searchable. The toolbar badge and a daily notification nudge pages that still have not been read through — reactivation, not a guilt scoreboard.

**Obsidian.** Dump a page plus its conversations to `obsidian://new` and a downloaded `.md` file. The note keeps URL, why-opened, parsed excerpt, highlight anchors, branch labels, and agent/user voice.

## Shortcuts

| Action | Default |
| --- | --- |
| Highlight selection | `Alt+H` |
| Comment on selection | `Alt+M` |
| Open dashboard | `Alt+Shift+L` |

Right-click a selection for the same actions.

## Settings

Obsidian vault name and folder, default color, default agent, daily reminder hour, and whether infinite pages stay locked until snapshot.

## Tests

```bash
npm test
```

## Limits (honest)

- This is an extension, not a research browser. It cannot rewrite navigation the way Horse Trails does.
- Agent connection is a **strict context packet** plus paste-back, not a live API into Cursor or Claude Code.
- Highlights use text-quote selectors. If a page rewrites the paragraph, the mark may not restore.
- Very large Obsidian URIs can fail; the downloaded markdown is the reliable copy.
