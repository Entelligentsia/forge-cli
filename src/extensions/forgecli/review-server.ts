import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ReviewFeedback {
	line: number;
	selectedText: string;
	comment: string;
}

/**
 * Starts a local HTTP server to host the review UI, opens the browser,
 * and waits for the user to submit feedback.
 */
export function startReviewServer(
	artifactPath: string,
	taskId: string,
): Promise<ReviewFeedback[]> {
	return new Promise((resolve, reject) => {
		const server = http.createServer(async (req, res) => {
			res.setHeader("Access-Control-Allow-Origin", "*");
			
			try {
				if (req.method === "GET" && req.url === "/") {
					// Serve the index.html viewer
					let html = getViewerHtml();
					
					// Inject the task ID into the HTML
					html = html.replace("{{TASK_ID}}", taskId);
					
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(html);
					return;
				}

				if (req.method === "GET" && req.url === "/api/artifact") {
					// Serve the raw markdown artifact
					const content = await fs.readFile(artifactPath, "utf-8");
					res.writeHead(200, { "Content-Type": "text/plain" });
					res.end(content);
					return;
				}

				if (req.method === "POST" && req.url === "/api/cancel") {
					// Browser unload / explicit cancel — resolve with empty array.
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ success: true }));
					server.close(() => resolve([]));
					return;
				}

				if (req.method === "POST" && req.url === "/api/feedback") {
					// Receive the feedback array
					let body = "";
					req.on("data", (chunk) => {
						body += chunk.toString();
					});
					req.on("end", () => {
						try {
							const feedback: ReviewFeedback[] = JSON.parse(body);
							res.writeHead(200, { "Content-Type": "application/json" });
							res.end(JSON.stringify({ success: true }));
							
							// Close the server and resolve the promise
							server.close(() => {
								resolve(feedback);
							});
						} catch (err) {
							res.writeHead(400, { "Content-Type": "application/json" });
							res.end(JSON.stringify({ error: "Invalid JSON" }));
						}
					});
					return;
				}

				// 404 for anything else
				res.writeHead(404);
				res.end("Not found");
			} catch (err) {
				console.error("[review-server] Error handling request:", err);
				res.writeHead(500);
				res.end("Internal Server Error");
			}
		});

		// Listen on a random available port
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Failed to get server address"));
				return;
			}
			
			const url = `http://127.0.0.1:${address.port}/`;
			
			// Open the browser (argv-array spawn — Iron Law 6)
			const isWin = process.platform === "win32";
			const cmd = process.platform === "darwin"
				? "open"
				: isWin ? "cmd" : "xdg-open";
			// win32 `start` needs an empty title arg first
			const argv = isWin ? ["/c", "start", "", url] : [url];

			try {
				const child = spawn(cmd, argv, { detached: true, stdio: "ignore" });
				child.on("error", () => {
					console.error("[review-server] Failed to open browser automatically. Please navigate to:", url);
				});
				child.unref();
			} catch {
				console.error("[review-server] Failed to open browser automatically. Please navigate to:", url);
			}
		});

		server.on("error", (err) => {
			reject(err);
		});
	});
}

function getViewerHtml(): string {
	return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>forge · review · {{TASK_ID}}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,700&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <style>
:root {
    --bg: #f6f1e8; --fg: #1a1612; --muted: #8b7355; --accent: #9c2a2a;
    --rule: #d6cdb8; --card: #fdf9f0;
    --highlight: rgba(212, 165, 116, 0.45); --highlight-hover: rgba(212, 165, 116, 0.75);
    --sev-blocker: #c0392b; --sev-question: #4a7ba6; --sev-nit: #8b7355; --sev-praise: #5a8a4a;
}
[data-theme="dark"] {
    --bg: #14110d; --fg: #e8dec9; --muted: #8b7355; --accent: #d4a574;
    --rule: #2a241c; --card: #1e1914;
    --highlight: rgba(212, 165, 116, 0.18); --highlight-hover: rgba(212, 165, 116, 0.38);
}
* { box-sizing: border-box; }
html, body { background: var(--bg); color: var(--fg); margin: 0; padding: 0; }
body {
    font-family: 'Newsreader', Georgia, serif;
    font-feature-settings: "kern", "liga", "onum";
    font-optical-sizing: auto;
    background-image:
        radial-gradient(circle at 50% -20%, rgba(212,165,116,0.06), transparent 50%),
        repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.012) 2px, rgba(0,0,0,0.012) 3px);
}
[data-theme="dark"] body {
    background-image:
        radial-gradient(circle at 50% -20%, rgba(212,165,116,0.04), transparent 50%),
        repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.012) 2px, rgba(255,255,255,0.012) 3px);
}
.font-display { font-family: 'Fraunces', serif; font-optical-sizing: auto; }
.font-mono { font-family: 'JetBrains Mono', monospace; }
.smallcaps { font-family: 'JetBrains Mono', monospace; font-size: 0.68rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }

.prose { font-size: 1.0625rem; line-height: 1.65; color: var(--fg); }
.prose h1 { font-family: 'Fraunces', serif; font-variation-settings: "opsz" 144; font-weight: 500; letter-spacing: -0.025em; font-size: 2.4rem; line-height: 1.05; margin: 0 0 1.5rem; }
.prose h2 { font-family: 'Fraunces', serif; font-variation-settings: "opsz" 72; font-weight: 500; letter-spacing: -0.015em; font-size: 1.55rem; line-height: 1.2; margin: 2.5rem 0 0.75rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); }
.prose h3 { font-family: 'Fraunces', serif; font-variation-settings: "opsz" 36; font-weight: 600; letter-spacing: -0.01em; font-size: 1.18rem; margin: 1.75rem 0 0.5rem; }
.prose p { margin: 0 0 1rem; }
.prose ul, .prose ol { margin: 0 0 1rem 1.25rem; padding: 0; }
.prose li { margin-bottom: 0.25rem; }
.prose code { font-family: 'JetBrains Mono', monospace; font-size: 0.86em; background: var(--rule); padding: 0.08em 0.3em; border-radius: 2px; }
.prose pre { font-family: 'JetBrains Mono', monospace; font-size: 0.83rem; line-height: 1.55; background: var(--card); border: 1px solid var(--rule); padding: 0.85rem 1rem; border-radius: 3px; overflow-x: auto; margin: 1rem 0; }
.prose pre code { background: transparent; padding: 0; }
.prose blockquote { border-left: 2px solid var(--accent); padding-left: 1rem; font-style: italic; color: var(--muted); margin: 1rem 0; }
.prose a { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; }
.prose hr { border: 0; border-top: 1px solid var(--rule); margin: 2rem 0; }
.prose table { font-size: 0.95rem; border-collapse: collapse; margin: 1rem 0; width: 100%; }
.prose th, .prose td { border-bottom: 1px solid var(--rule); padding: 0.4rem 0.75rem; text-align: left; }
.prose th { font-family: 'JetBrains Mono', monospace; font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 500; }
.prose strong { font-weight: 600; }
.prose em { font-style: italic; }

::selection { background: var(--highlight-hover); color: var(--fg); }

mark.anno { background: var(--highlight); border-bottom: 1px solid var(--accent); padding: 0.05em 0; cursor: pointer; transition: background 0.15s ease, border-bottom-width 0.15s ease; }
mark.anno:hover, mark.anno.focused { background: var(--highlight-hover); border-bottom-width: 2px; }
mark.anno[data-severity="blocker"] { border-bottom-color: var(--sev-blocker); }
mark.anno[data-severity="question"] { border-bottom-color: var(--sev-question); }
mark.anno[data-severity="nit"] { border-bottom-color: var(--sev-nit); }
mark.anno[data-severity="praise"] { border-bottom-color: var(--sev-praise); }

#connectors { position: absolute; top: 0; left: 0; pointer-events: none; z-index: 1; }
#connectors path { fill: none; stroke: var(--accent); stroke-width: 0.75; opacity: 0.25; transition: opacity 0.15s, stroke-width 0.15s; }
#connectors path.focused { opacity: 0.75; stroke-width: 1.25; }

.note { background: var(--card); border: 1px solid var(--rule); border-radius: 2px; padding: 0.75rem 0.9rem; position: absolute; width: 320px; font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; line-height: 1.45; transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease; cursor: pointer; z-index: 2; }
.note:hover, .note.focused { border-color: var(--accent); box-shadow: -2px 2px 0 var(--accent); transform: translateX(-2px); }
.note-quote { font-family: 'Newsreader', serif; font-style: italic; font-size: 0.85rem; color: var(--muted); border-left: 1px solid var(--rule); padding-left: 0.5rem; margin-bottom: 0.5rem; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.note-body { color: var(--fg); white-space: pre-wrap; word-wrap: break-word; }
.note-meta { display: flex; justify-content: space-between; margin-top: 0.6rem; align-items: center; }
.note-sev { font-family: 'JetBrains Mono', monospace; font-size: 0.62rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
.note-sev[data-sev="blocker"] { color: var(--sev-blocker); }
.note-sev[data-sev="question"] { color: var(--sev-question); }
.note-sev[data-sev="nit"] { color: var(--sev-nit); }
.note-sev[data-sev="praise"] { color: var(--sev-praise); }
.note-idx { color: var(--muted); font-size: 0.62rem; font-variant-numeric: tabular-nums; }
.note-actions { opacity: 0; transition: opacity 0.15s; display: flex; gap: 0.5rem; }
.note:hover .note-actions, .note.focused .note-actions { opacity: 1; }
.note-actions button { background: transparent; border: 0; color: var(--muted); cursor: pointer; padding: 0; font-family: 'JetBrains Mono', monospace; font-size: 0.65rem; letter-spacing: 0.05em; text-transform: uppercase; }
.note-actions button:hover { color: var(--accent); }

#composer { position: absolute; display: none; background: var(--card); border: 1px solid var(--accent); border-radius: 2px; padding: 0.6rem; width: 360px; z-index: 50; box-shadow: -2px 2px 0 var(--accent), 0 8px 24px rgba(0,0,0,0.12); }
#composer textarea { width: 100%; border: 1px solid var(--rule); background: var(--bg); color: var(--fg); font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; line-height: 1.45; padding: 0.5rem 0.6rem; resize: vertical; min-height: 80px; outline: none; border-radius: 2px; }
#composer textarea:focus { border-color: var(--accent); }
.sev-pills { display: flex; gap: 0.3rem; margin-bottom: 0.5rem; }
.sev-pill { font-family: 'JetBrains Mono', monospace; font-size: 0.62rem; letter-spacing: 0.1em; text-transform: uppercase; padding: 0.18rem 0.45rem; border: 1px solid var(--rule); color: var(--muted); cursor: pointer; user-select: none; transition: all 0.1s; background: transparent; }
.sev-pill:hover { color: var(--fg); }
.sev-pill.active { border-color: var(--accent); color: var(--accent); }

.empty-margin { position: absolute; right: 0.5rem; top: 35vh; font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; letter-spacing: 0.3em; text-transform: uppercase; color: var(--muted); writing-mode: vertical-rl; transform: rotate(180deg); opacity: 0.45; pointer-events: none; }

#header { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 1.5rem; border-bottom: 1px solid var(--rule); background: var(--bg); z-index: 30; flex-shrink: 0; }
#header .left, #header .right { display: flex; align-items: center; gap: 0.75rem; }
#header .right { gap: 0.25rem; }

#statusbar { display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 1.5rem; font-family: 'JetBrains Mono', monospace; font-size: 0.68rem; color: var(--muted); letter-spacing: 0.05em; border-top: 1px solid var(--rule); background: var(--bg); z-index: 30; flex-shrink: 0; }
#statusbar .group { display: flex; gap: 1.25rem; align-items: center; }

.btn { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; padding: 0.42rem 0.85rem; border: 1px solid var(--fg); background: var(--bg); color: var(--fg); cursor: pointer; transition: all 0.15s; display: inline-flex; align-items: center; gap: 0.4rem; border-radius: 0; }
.btn:hover { background: var(--fg); color: var(--bg); }
.btn-primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.btn-primary:hover { background: var(--fg); border-color: var(--fg); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.icon-btn { background: transparent; border: 0; color: var(--muted); font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer; padding: 0.3rem 0.4rem; }
.icon-btn:hover { color: var(--fg); }

.kbd { font-family: 'JetBrains Mono', monospace; font-size: 0.62rem; padding: 0.1rem 0.32rem; border: 1px solid var(--rule); border-bottom-width: 2px; border-radius: 2px; background: var(--card); color: var(--muted); display: inline-block; line-height: 1.2; }
.kbd-on-accent { color: inherit; border-color: currentColor; background: transparent; }

#help-modal { position: fixed; inset: 0; display: none; background: rgba(0,0,0,0.45); z-index: 100; align-items: center; justify-content: center; }
#help-modal.open { display: flex; }
#help-modal .panel { background: var(--bg); border: 1px solid var(--accent); padding: 2rem 2.4rem; max-width: 540px; width: 90%; box-shadow: -4px 4px 0 var(--accent); }
.help-row { display: flex; justify-content: space-between; align-items: center; margin: 0.35rem 0; }
.help-label { color: var(--muted); font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; }

.stamp { font-family: 'Fraunces', serif; font-variation-settings: "opsz" 144; font-weight: 700; font-size: 3.6rem; letter-spacing: -0.04em; color: var(--accent); text-transform: uppercase; border: 3px solid var(--accent); border-radius: 4px; padding: 1.2rem 2.6rem; transform: rotate(-6deg); display: inline-block; animation: stamp 0.55s cubic-bezier(0.34, 1.56, 0.64, 1); }
@keyframes stamp { 0% { transform: rotate(-6deg) scale(2.2); opacity: 0; } 60% { transform: rotate(-6deg) scale(0.92); opacity: 1; } 100% { transform: rotate(-6deg) scale(1); opacity: 1; } }

.skel-line { background: linear-gradient(90deg, var(--rule) 0%, var(--card) 50%, var(--rule) 100%); background-size: 200% 100%; animation: shimmer 1.4s infinite; height: 0.95rem; border-radius: 2px; margin-bottom: 0.55rem; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

#app { display: flex; flex-direction: column; height: 100vh; }
#main { flex: 1; overflow: hidden; position: relative; }
#scroll { position: absolute; inset: 0; overflow-y: auto; }
#layout { max-width: 1340px; margin: 0 auto; padding: 3rem 1.5rem; position: relative; min-height: 100%; }
#content { max-width: 680px; position: relative; z-index: 2; }
#margin { position: absolute; top: 3rem; bottom: 3rem; left: calc(680px + 7rem); right: 1rem; }
.err { color: var(--sev-blocker); font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; }
    </style>
</head>
<body>
<div id="app">
    <header id="header">
        <div class="left">
            <span class="font-display" style="font-size: 1.25rem; font-variation-settings: 'opsz' 72; font-weight: 600; letter-spacing: -0.02em">forge</span>
            <span class="smallcaps">Review</span>
            <span class="font-mono" style="font-size: 0.85rem; color: var(--muted)">·</span>
            <span class="font-mono" style="font-size: 0.85rem">{{TASK_ID}}</span>
        </div>
        <div class="right">
            <button id="theme-toggle" class="icon-btn" title="Toggle theme (t)">◐ Theme</button>
            <button id="help-btn" class="icon-btn" title="Help (?)">? Help</button>
            <button id="submit-btn" class="btn btn-primary" style="margin-left: 0.5rem">
                Deliver <span class="kbd kbd-on-accent">⌘S</span>
            </button>
        </div>
    </header>

    <main id="main">
        <div id="scroll">
            <div id="layout">
                <article id="content" class="prose">
                    <div class="skel-line" style="width: 60%"></div>
                    <div class="skel-line" style="width: 100%"></div>
                    <div class="skel-line" style="width: 92%"></div>
                    <div class="skel-line" style="width: 78%"></div>
                </article>
                <svg id="connectors" width="100%" height="100%"></svg>
                <aside id="margin">
                    <div class="empty-margin" id="empty-margin">— select to mark —</div>
                </aside>
            </div>
        </div>
    </main>

    <footer id="statusbar">
        <div class="group">
            <span><span id="count">0</span> notes</span>
            <span style="color: var(--rule)">·</span>
            <span id="save-state">no notes</span>
        </div>
        <div class="group">
            <span><span class="kbd">c</span> comment</span>
            <span><span class="kbd">j</span>/<span class="kbd">k</span> nav</span>
            <span><span class="kbd">?</span> help</span>
        </div>
    </footer>
</div>

<div id="composer">
    <div class="sev-pills">
        <button class="sev-pill active" data-sev="">note</button>
        <button class="sev-pill" data-sev="question">?</button>
        <button class="sev-pill" data-sev="nit">nit</button>
        <button class="sev-pill" data-sev="blocker">blocker</button>
        <button class="sev-pill" data-sev="praise">+1</button>
    </div>
    <textarea id="composer-text" placeholder="// your note · cmd-enter save · esc cancel"></textarea>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.5rem">
        <span class="smallcaps">⌘↵ save · esc cancel</span>
        <div style="display: flex; gap: 0.5rem">
            <button class="btn" id="composer-cancel">Cancel</button>
            <button class="btn btn-primary" id="composer-save">Save</button>
        </div>
    </div>
</div>

<div id="help-modal">
    <div class="panel">
        <div class="smallcaps" style="margin-bottom: 0.25rem">forge review</div>
        <h2 class="font-display" style="font-size: 1.8rem; margin: 0 0 1.2rem; font-variation-settings: 'opsz' 72; font-weight: 600; letter-spacing: -0.02em">Keyboard</h2>
        <div class="help-row"><span class="help-label">Comment on selection</span><span class="kbd">c</span></div>
        <div class="help-row"><span class="help-label">Next note</span><span class="kbd">j</span></div>
        <div class="help-row"><span class="help-label">Previous note</span><span class="kbd">k</span></div>
        <div class="help-row"><span class="help-label">Edit focused note</span><span class="kbd">e</span></div>
        <div class="help-row"><span class="help-label">Delete focused note</span><span class="kbd">d</span></div>
        <div class="help-row"><span class="help-label">Save composer</span><span class="kbd">⌘↵</span></div>
        <div class="help-row"><span class="help-label">Cancel</span><span class="kbd">esc</span></div>
        <div class="help-row"><span class="help-label">Deliver feedback</span><span class="kbd">⌘S</span></div>
        <div class="help-row"><span class="help-label">Toggle theme</span><span class="kbd">t</span></div>
        <div class="help-row"><span class="help-label">This panel</span><span class="kbd">?</span></div>
        <div style="margin-top: 1.3rem; padding-top: 1rem; border-top: 1px solid var(--rule)">
            <p style="margin: 0; color: var(--muted); font-family: 'Newsreader', serif; font-style: italic; font-size: 0.95rem">
                Drafts autosave to localStorage. Reload-safe.
            </p>
        </div>
    </div>
</div>

    <script>
var TASK_ID = '{{TASK_ID}}';
var STORAGE_KEY = 'forge:review:drafts:' + TASK_ID;
var THEME_KEY = 'forge:review:theme';

var notes = [];
var focusedId = null;
var composing = null;
var composerSev = '';
var sourceMarkdown = '';
var saveStateTimer = null;
var delivered = false;

// Notify CLI on tab close / navigation so the watcher unblocks.
window.addEventListener('pagehide', function () {
    if (delivered) return;
    try { navigator.sendBeacon('/api/cancel', '{}'); } catch (e) { /* ignore */ }
});
window.addEventListener('beforeunload', function () {
    if (delivered) return;
    try { navigator.sendBeacon('/api/cancel', '{}'); } catch (e) { /* ignore */ }
});

(function initTheme() {
    var saved = localStorage.getItem(THEME_KEY);
    var sys = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = saved || (sys ? 'dark' : 'light');
})();
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
function toggleTheme() {
    var cur = document.documentElement.dataset.theme;
    var nxt = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = nxt;
    localStorage.setItem(THEME_KEY, nxt);
    setTimeout(layoutAll, 50);
}

async function loadArtifact() {
    try {
        var res = await fetch('/api/artifact');
        if (!res.ok) throw new Error('fetch ' + res.status);
        sourceMarkdown = await res.text();
        var rendered = marked.parse(sourceMarkdown);
        var contentEl = document.getElementById('content');
        contentEl.replaceChildren();
        var parser = new DOMParser();
        var doc = parser.parseFromString('<div>' + rendered + '</div>', 'text/html');
        var src = doc.body.firstChild;
        while (src && src.firstChild) contentEl.appendChild(src.firstChild);
        restoreDrafts();
        layoutAll();
    } catch (err) {
        var p = document.createElement('p');
        p.className = 'err';
        p.textContent = 'Failed to load artifact: ' + err.message;
        document.getElementById('content').replaceChildren(p);
    }
}

function getSelectionInfo() {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    var range = sel.getRangeAt(0);
    var text = sel.toString().trim();
    if (!text || text.length < 2) return null;
    var content = document.getElementById('content');
    if (!content.contains(range.commonAncestorContainer)) return null;
    return { range: range, text: text };
}

function wrapRange(range, id, severity) {
    var root = range.commonAncestorContainer.nodeType === 3
        ? range.commonAncestorContainer.parentNode
        : range.commonAncestorContainer;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
            if (!range.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
            if (n.parentNode && n.parentNode.tagName === 'MARK') return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    var targets = [];
    var n;
    while ((n = walker.nextNode())) targets.push(n);
    var startContainer = range.startContainer;
    var endContainer = range.endContainer;
    var startOffset = range.startOffset;
    var endOffset = range.endOffset;
    for (var i = 0; i < targets.length; i++) {
        var tn = targets[i];
        var from = 0, to = tn.nodeValue.length;
        if (tn === startContainer) from = startOffset;
        if (tn === endContainer) to = endOffset;
        if (from >= to) continue;
        var segText = tn.nodeValue.slice(from, to);
        if (!segText) continue;
        var mark = document.createElement('mark');
        mark.className = 'anno';
        mark.dataset.id = id;
        if (severity) mark.dataset.severity = severity;
        mark.textContent = segText;
        var beforeText = tn.nodeValue.slice(0, from);
        var afterText = tn.nodeValue.slice(to);
        var parent = tn.parentNode;
        if (afterText) parent.insertBefore(document.createTextNode(afterText), tn.nextSibling);
        parent.insertBefore(mark, tn.nextSibling);
        tn.nodeValue = beforeText;
        if (!beforeText) parent.removeChild(tn);
    }
}

function unwrapMarks(id) {
    var marks = document.querySelectorAll('mark.anno[data-id="' + id + '"]');
    for (var i = 0; i < marks.length; i++) {
        var m = marks[i];
        var parent = m.parentNode;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
        parent.normalize();
    }
}

function setMarkSeverity(id, sev) {
    var marks = document.querySelectorAll('mark.anno[data-id="' + id + '"]');
    for (var i = 0; i < marks.length; i++) {
        if (sev) marks[i].dataset.severity = sev;
        else delete marks[i].dataset.severity;
    }
}

var composerEl = document.getElementById('composer');
var composerText = document.getElementById('composer-text');

function openComposerForSelection(info) {
    var id = 'n' + Date.now().toString(36) + Math.floor(Math.random() * 10000).toString(36);
    var rect = info.range.getBoundingClientRect();
    var scrollEl = document.getElementById('scroll');
    var lineEstimate = Math.max(1, Math.floor((rect.top + scrollEl.scrollTop) / 24));
    wrapRange(info.range, id, '');
    window.getSelection().removeAllRanges();
    composing = { id: id, selectedText: info.text, lineEstimate: lineEstimate, isNew: true };
    composerSev = '';
    updateSevPills();
    composerText.value = '';
    positionComposerAtMark(id);
    composerText.focus();
}

function openComposerForEdit(id) {
    var note = findNote(id);
    if (!note) return;
    composing = { id: id, selectedText: note.selectedText, lineEstimate: note.lineEstimate, isNew: false };
    composerSev = note.severity || '';
    updateSevPills();
    composerText.value = note.comment;
    positionComposerAtMark(id);
    composerText.focus();
    composerText.setSelectionRange(composerText.value.length, composerText.value.length);
}

function updateSevPills() {
    var pills = document.querySelectorAll('.sev-pill');
    for (var i = 0; i < pills.length; i++) {
        pills[i].classList.toggle('active', pills[i].dataset.sev === composerSev);
    }
}

function positionComposerAtMark(id) {
    var m = document.querySelector('mark.anno[data-id="' + id + '"]');
    if (!m) return;
    var r = m.getBoundingClientRect();
    composerEl.style.display = 'block';
    var top = r.bottom + window.scrollY + 8;
    var left = Math.max(16, Math.min(r.left + window.scrollX, window.innerWidth - 380));
    composerEl.style.top = top + 'px';
    composerEl.style.left = left + 'px';
}

function closeComposer(commit) {
    if (!composing) { composerEl.style.display = 'none'; return; }
    if (commit) {
        var text = composerText.value.trim();
        if (!text) { closeComposer(false); return; }
        if (composing.isNew) {
            notes.push({
                id: composing.id,
                selectedText: composing.selectedText,
                comment: text,
                severity: composerSev,
                lineEstimate: composing.lineEstimate,
            });
            setMarkSeverity(composing.id, composerSev);
        } else {
            var note = findNote(composing.id);
            if (note) {
                note.comment = text;
                note.severity = composerSev;
                setMarkSeverity(composing.id, composerSev);
            }
        }
        saveDrafts();
        focusedId = composing.id;
    } else if (composing.isNew) {
        unwrapMarks(composing.id);
    }
    composerEl.style.display = 'none';
    composing = null;
    layoutAll();
}

document.getElementById('composer-save').addEventListener('click', function () { closeComposer(true); });
document.getElementById('composer-cancel').addEventListener('click', function () { closeComposer(false); });
var sevPillEls = document.querySelectorAll('.sev-pill');
for (var spi = 0; spi < sevPillEls.length; spi++) {
    sevPillEls[spi].addEventListener('click', function (e) {
        composerSev = e.currentTarget.dataset.sev;
        updateSevPills();
        composerText.focus();
    });
}
composerText.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); closeComposer(true); }
    else if (e.key === 'Escape') { e.preventDefault(); closeComposer(false); }
});

function findNote(id) {
    for (var i = 0; i < notes.length; i++) if (notes[i].id === id) return notes[i];
    return null;
}

function layoutAll() {
    var margin = document.getElementById('margin');
    var svg = document.getElementById('connectors');
    var emptyMargin = document.getElementById('empty-margin');
    var existing = margin.querySelectorAll('.note');
    for (var i = 0; i < existing.length; i++) existing[i].remove();
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    if (notes.length === 0) {
        emptyMargin.style.display = 'block';
        updateCount();
        return;
    }
    emptyMargin.style.display = 'none';

    var layout = document.getElementById('layout');
    var layoutRect = layout.getBoundingClientRect();

    var ordered = [];
    for (var j = 0; j < notes.length; j++) {
        var m = document.querySelector('mark.anno[data-id="' + notes[j].id + '"]');
        if (!m) continue;
        var r = m.getBoundingClientRect();
        ordered.push({ note: notes[j], top: r.top - layoutRect.top, mark: m });
    }
    ordered.sort(function (a, b) { return a.top - b.top; });

    var cursor = 0;
    var marginTopOffset = 48; // matches #margin top: 3rem
    for (var k = 0; k < ordered.length; k++) {
        var entry = ordered[k];
        var card = renderNote(entry.note, k + 1);
        margin.appendChild(card);
        var cardHeight = card.offsetHeight;
        var desired = entry.top;
        if (desired < cursor + 4) desired = cursor + 4;
        card.style.top = (desired - marginTopOffset) + 'px';
        cursor = desired + cardHeight + 12;
        entry.cardTop = desired;
    }

    var marginRect = margin.getBoundingClientRect();
    var marginLeft = marginRect.left - layoutRect.left;
    svg.setAttribute('width', layoutRect.width);
    svg.setAttribute('height', layout.scrollHeight);
    svg.setAttribute('viewBox', '0 0 ' + layoutRect.width + ' ' + layout.scrollHeight);
    for (var p = 0; p < ordered.length; p++) {
        var e2 = ordered[p];
        var marks = document.querySelectorAll('mark.anno[data-id="' + e2.note.id + '"]');
        if (marks.length === 0) continue;
        var last = marks[marks.length - 1];
        var lr = last.getBoundingClientRect();
        var x1 = lr.right - layoutRect.left;
        var y1 = lr.top - layoutRect.top + lr.height / 2;
        var x2 = marginLeft;
        var y2 = e2.cardTop + 18;
        var dx = x2 - x1;
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        var d = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + dx * 0.5) + ' ' + y1 + ', ' + (x2 - dx * 0.5) + ' ' + y2 + ', ' + x2 + ' ' + y2;
        path.setAttribute('d', d);
        path.dataset.id = e2.note.id;
        svg.appendChild(path);
    }

    applyFocus();
    updateCount();
}

function renderNote(note, idx) {
    var card = document.createElement('div');
    card.className = 'note';
    card.dataset.id = note.id;
    if (note.id === focusedId) card.classList.add('focused');

    var quote = document.createElement('div');
    quote.className = 'note-quote';
    quote.textContent = '“' + note.selectedText + '”';

    var body = document.createElement('div');
    body.className = 'note-body';
    body.textContent = note.comment;

    var meta = document.createElement('div');
    meta.className = 'note-meta';

    var sev = document.createElement('span');
    sev.className = 'note-sev';
    sev.dataset.sev = note.severity || '';
    sev.textContent = note.severity || 'note';

    var right = document.createElement('div');
    right.style.cssText = 'display: flex; align-items: center; gap: 0.75rem';

    var actions = document.createElement('span');
    actions.className = 'note-actions';
    var editBtn = document.createElement('button');
    editBtn.dataset.act = 'edit';
    editBtn.dataset.id = note.id;
    editBtn.title = 'Edit (e)';
    editBtn.textContent = 'edit';
    var delBtn = document.createElement('button');
    delBtn.dataset.act = 'del';
    delBtn.dataset.id = note.id;
    delBtn.title = 'Delete (d)';
    delBtn.textContent = 'del';
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    var idxEl = document.createElement('span');
    idxEl.className = 'note-idx';
    idxEl.textContent = idx < 10 ? '0' + idx : String(idx);

    right.appendChild(actions);
    right.appendChild(idxEl);
    meta.appendChild(sev);
    meta.appendChild(right);

    card.appendChild(quote);
    card.appendChild(body);
    card.appendChild(meta);

    card.addEventListener('click', function (e) {
        var btn = e.target.closest && e.target.closest('button[data-act]');
        if (btn) {
            e.stopPropagation();
            var id = btn.dataset.id;
            if (btn.dataset.act === 'edit') openComposerForEdit(id);
            else if (btn.dataset.act === 'del') deleteNote(id);
            return;
        }
        focusNote(note.id);
        scrollToMark(note.id);
    });
    return card;
}

function scrollToMark(id) {
    var m = document.querySelector('mark.anno[data-id="' + id + '"]');
    if (m && m.scrollIntoView) m.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function focusNote(id) {
    focusedId = id;
    applyFocus();
}

function applyFocus() {
    var cards = document.querySelectorAll('.note');
    for (var i = 0; i < cards.length; i++) cards[i].classList.toggle('focused', cards[i].dataset.id === focusedId);
    var marks = document.querySelectorAll('mark.anno');
    for (var j = 0; j < marks.length; j++) marks[j].classList.toggle('focused', marks[j].dataset.id === focusedId);
    var paths = document.querySelectorAll('#connectors path');
    for (var k = 0; k < paths.length; k++) paths[k].classList.toggle('focused', paths[k].dataset.id === focusedId);
}

function deleteNote(id) {
    notes = notes.filter(function (n) { return n.id !== id; });
    unwrapMarks(id);
    if (focusedId === id) focusedId = null;
    saveDrafts();
    layoutAll();
}

function updateCount() {
    document.getElementById('count').textContent = notes.length;
}

function saveDrafts() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            ts: Date.now(),
            notes: notes,
            sig: sourceMarkdown.slice(0, 128),
        }));
        setSaveState('draft synced');
    } catch (e) {
        setSaveState('save failed');
    }
}

function restoreDrafts() {
    try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        var data = JSON.parse(raw);
        if (data.sig && data.sig !== sourceMarkdown.slice(0, 128)) {
            localStorage.removeItem(STORAGE_KEY);
            setSaveState('draft mismatch — discarded');
            return;
        }
        var savedNotes = data.notes || [];
        for (var i = 0; i < savedNotes.length; i++) {
            var n = savedNotes[i];
            if (findAndWrapText(n.selectedText, n.id, n.severity)) notes.push(n);
        }
        if (notes.length) setSaveState('restored ' + notes.length + ' note' + (notes.length === 1 ? '' : 's'));
    } catch (e) { /* ignore */ }
}

function findAndWrapText(text, id, severity) {
    var content = document.getElementById('content');
    var walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    var n;
    while ((n = walker.nextNode())) {
        if (n.parentNode && n.parentNode.tagName === 'MARK') continue;
        var idx = n.nodeValue.indexOf(text);
        if (idx >= 0) {
            var range = document.createRange();
            range.setStart(n, idx);
            range.setEnd(n, idx + text.length);
            wrapRange(range, id, severity);
            return true;
        }
    }
    return false;
}

function setSaveState(msg) {
    document.getElementById('save-state').textContent = msg;
    if (saveStateTimer) clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(function () {
        document.getElementById('save-state').textContent = notes.length ? 'draft synced' : 'no notes';
    }, 2000);
}

async function submitAll() {
    if (notes.length === 0) { setSaveState('nothing to deliver'); return; }
    var btn = document.getElementById('submit-btn');
    btn.disabled = true;
    var prevText = btn.textContent;
    btn.textContent = 'Delivering…';
    try {
        var payload = notes.map(function (n) {
            return {
                selectedText: n.selectedText,
                comment: n.severity ? '[' + n.severity + '] ' + n.comment : n.comment,
                line: n.lineEstimate || 1,
            };
        });
        var res = await fetch('/api/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('server ' + res.status);
        delivered = true;
        localStorage.removeItem(STORAGE_KEY);
        renderDelivered(notes.length);
    } catch (err) {
        btn.disabled = false;
        btn.textContent = prevText;
        alert('Delivery failed: ' + err.message);
    }
}

function renderDelivered(n) {
    var root = document.createElement('div');
    root.style.cssText = 'height: 100vh; width: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1.5rem; background: var(--bg); color: var(--fg)';
    var stamp = document.createElement('div');
    stamp.className = 'stamp';
    stamp.textContent = 'Delivered';
    var msg = document.createElement('p');
    msg.className = 'font-mono';
    msg.style.cssText = 'font-size: 0.85rem; color: var(--muted)';
    msg.textContent = n + ' note' + (n === 1 ? '' : 's') + ' sent to forge · close this tab';
    root.appendChild(stamp);
    root.appendChild(msg);
    document.body.replaceChildren(root);
}

document.addEventListener('keydown', function (e) {
    if (composerEl.style.display === 'block') return;
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); submitAll(); return; }
    if (e.key === '?') { e.preventDefault(); toggleHelp(); return; }
    if (e.key === 'Escape') { closeHelp(); return; }
    if (e.key === 't') { toggleTheme(); return; }
    if (e.key === 'c') {
        var info = getSelectionInfo();
        if (info) { e.preventDefault(); openComposerForSelection(info); }
        return;
    }
    if (e.key === 'j' || e.key === 'k') {
        if (notes.length === 0) return;
        e.preventDefault();
        var ids = notes.map(function (x) { return x.id; });
        var ix = ids.indexOf(focusedId);
        if (e.key === 'j') ix = (ix + 1) % ids.length;
        else ix = (ix - 1 + ids.length) % ids.length;
        focusNote(ids[ix]);
        scrollToMark(ids[ix]);
        return;
    }
    if (e.key === 'e' && focusedId) { e.preventDefault(); openComposerForEdit(focusedId); return; }
    if (e.key === 'd' && focusedId) { e.preventDefault(); deleteNote(focusedId); return; }
});

document.getElementById('submit-btn').addEventListener('click', submitAll);
document.getElementById('help-btn').addEventListener('click', toggleHelp);
document.getElementById('help-modal').addEventListener('click', function (e) {
    if (e.target.id === 'help-modal') closeHelp();
});
function toggleHelp() { document.getElementById('help-modal').classList.toggle('open'); }
function closeHelp() { document.getElementById('help-modal').classList.remove('open'); }

document.addEventListener('mouseup', function (e) {
    if (composerEl.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.note')) return;
    if (e.target.closest && e.target.closest('mark.anno')) return;
    setTimeout(function () {
        var info = getSelectionInfo();
        if (info && !composing) openComposerForSelection(info);
    }, 0);
});

document.addEventListener('click', function (e) {
    var m = e.target.closest && e.target.closest('mark.anno');
    if (m) focusNote(m.dataset.id);
});

window.addEventListener('resize', layoutAll);
document.getElementById('scroll').addEventListener('scroll', function () {
    if (composing) positionComposerAtMark(composing.id);
});

loadArtifact();
    </script>
</body>
</html>`;
}
