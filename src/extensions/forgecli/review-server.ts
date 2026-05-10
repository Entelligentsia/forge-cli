import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
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
			
			// Open the browser
			const startCmd =
				process.platform === "darwin"
					? "open"
					: process.platform === "win32"
						? "start"
						: "xdg-open";
						
			exec(`${startCmd} ${url}`, (err) => {
				if (err) {
					console.error("[review-server] Failed to open browser automatically. Please navigate to:", url);
				}
			});
		});

		server.on("error", (err) => {
			reject(err);
		});
	});
}

function getViewerHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Forge Review - {{TASK_ID}}</title>
    <!-- Use Tailwind via CDN for quick styling -->
    <script src="https://cdn.tailwindcss.com"></script>
    <!-- Use marked via CDN for markdown rendering -->
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <style>
        .prose pre { background-color: #1f2937; color: #f3f4f6; padding: 1rem; border-radius: 0.375rem; }
        .prose code { background-color: #f3f4f6; padding: 0.125rem 0.25rem; border-radius: 0.25rem; font-size: 0.875em; }
        ::selection { background-color: #fde047; color: #1f2937; }
        
        #comment-popup {
            display: none;
            position: absolute;
            z-index: 50;
            background: white;
            border: 1px solid #e5e7eb;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            border-radius: 0.375rem;
            padding: 0.5rem;
            width: 300px;
        }
        
        .highlighted-text {
            background-color: #fef08a; /* yellow-200 */
            border-bottom: 2px solid #eab308; /* yellow-500 */
        }
    </style>
</head>
<body class="bg-gray-50 text-gray-900 h-screen flex overflow-hidden">
    
    <!-- Main Content Area -->
    <div class="flex-1 overflow-y-auto p-8 relative" id="main-scroll">
        <div class="max-w-4xl mx-auto bg-white p-10 rounded-lg shadow-sm border border-gray-200">
            <h1 class="text-2xl font-bold mb-6 pb-2 border-b border-gray-200">Review Artifact: {{TASK_ID}}</h1>
            
            <div id="content" class="prose max-w-none">
                <div class="animate-pulse flex space-x-4">
                    <div class="flex-1 space-y-4 py-1">
                        <div class="h-4 bg-gray-200 rounded w-3/4"></div>
                        <div class="space-y-2">
                            <div class="h-4 bg-gray-200 rounded"></div>
                            <div class="h-4 bg-gray-200 rounded w-5/6"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Sidebar for Comments -->
    <div class="w-96 bg-white border-l border-gray-200 flex flex-col shadow-xl z-10">
        <div class="p-4 border-b border-gray-200 bg-gray-50 flex justify-between items-center">
            <h2 class="text-lg font-semibold text-gray-800">Feedback Notes</h2>
            <span id="comment-count" class="bg-blue-100 text-blue-800 text-xs font-medium px-2.5 py-0.5 rounded-full">0</span>
        </div>
        
        <div id="comments-list" class="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50">
            <div id="empty-state" class="text-center text-gray-500 mt-10 text-sm">
                <p>No feedback added yet.</p>
                <p class="mt-2">Select text in the document to add a note.</p>
            </div>
        </div>
        
        <div class="p-4 border-t border-gray-200 bg-white">
            <button id="submit-btn" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-md shadow-sm transition-colors flex justify-center items-center">
                Submit Feedback to Forge
            </button>
            <p class="text-xs text-gray-500 text-center mt-2">This will close the window and trigger the AI.</p>
        </div>
    </div>

    <!-- Floating Popup -->
    <div id="comment-popup">
        <div class="mb-2">
            <label class="block text-xs font-medium text-gray-700 mb-1">Selected text:</label>
            <div id="popup-selected-text" class="text-sm bg-gray-50 p-2 rounded border border-gray-200 truncate italic text-gray-600"></div>
        </div>
        <textarea id="popup-textarea" rows="3" class="w-full text-sm border-gray-300 rounded-md shadow-sm focus:border-blue-500 focus:ring-blue-500 border p-2" placeholder="Add your feedback..."></textarea>
        <div class="mt-2 flex justify-end space-x-2">
            <button id="popup-cancel" class="px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 rounded-md border border-gray-300">Cancel</button>
            <button id="popup-save" class="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md">Save Note</button>
        </div>
    </div>

    <script>
        let feedbackList = [];
        let currentSelection = null;

        // Fetch and render markdown
        async function loadArtifact() {
            try {
                const response = await fetch('/api/artifact');
                if (!response.ok) throw new Error("Failed to fetch artifact");
                const markdown = await response.text();
                
                // Render markdown
                document.getElementById('content').innerHTML = marked.parse(markdown);
                
                setupSelectionHandler();
            } catch (err) {
                document.getElementById('content').innerHTML = \`
                    <div class="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded relative" role="alert">
                        <strong class="font-bold">Error!</strong>
                        <span class="block sm:inline"> Could not load artifact. \${err.message}</span>
                    </div>\`;
            }
        }

        function setupSelectionHandler() {
            const contentDiv = document.getElementById('content');
            const popup = document.getElementById('comment-popup');
            const mainScroll = document.getElementById('main-scroll');
            
            document.addEventListener('mouseup', (e) => {
                // Ignore clicks inside the popup or sidebar
                if (popup.contains(e.target) || e.target.closest('.w-96')) {
                    return;
                }

                const selection = window.getSelection();
                const text = selection.toString().trim();
                
                if (text && contentDiv.contains(selection.anchorNode)) {
                    // Show popup near the selection
                    const range = selection.getRangeAt(0);
                    const rect = range.getBoundingClientRect();
                    
                    // Calculate position relative to viewport
                    const top = rect.bottom + window.scrollY + 10;
                    const left = Math.max(20, rect.left + window.scrollX - 150);
                    
                    popup.style.top = \`\${top}px\`;
                    popup.style.left = \`\${left}px\`;
                    popup.style.display = 'block';
                    
                    document.getElementById('popup-selected-text').textContent = text;
                    document.getElementById('popup-textarea').value = '';
                    document.getElementById('popup-textarea').focus();
                    
                    currentSelection = {
                        text: text,
                        // Rough estimate of line number based on vertical position
                        lineEstimate: Math.floor(rect.top / 24) 
                    };
                } else {
                    // Don't hide if clicking inside textarea
                    if (!popup.contains(e.target)) {
                        popup.style.display = 'none';
                        currentSelection = null;
                    }
                }
            });

            document.getElementById('popup-cancel').addEventListener('click', () => {
                popup.style.display = 'none';
                currentSelection = null;
                window.getSelection().removeAllRanges();
            });

            document.getElementById('popup-save').addEventListener('click', () => {
                const comment = document.getElementById('popup-textarea').value.trim();
                if (comment && currentSelection) {
                    addFeedback({
                        selectedText: currentSelection.text,
                        comment: comment,
                        line: currentSelection.lineEstimate
                    });
                    
                    popup.style.display = 'none';
                    currentSelection = null;
                    window.getSelection().removeAllRanges();
                }
            });
        }

        function addFeedback(item) {
            feedbackList.push(item);
            renderComments();
        }

        function removeFeedback(index) {
            feedbackList.splice(index, 1);
            renderComments();
        }

        function renderComments() {
            const listEl = document.getElementById('comments-list');
            const emptyEl = document.getElementById('empty-state');
            const countEl = document.getElementById('comment-count');
            
            countEl.textContent = feedbackList.length;
            
            if (feedbackList.length === 0) {
                emptyEl.style.display = 'block';
                listEl.innerHTML = '';
                listEl.appendChild(emptyEl);
                return;
            }
            
            emptyEl.style.display = 'none';
            listEl.innerHTML = '';
            
            feedbackList.forEach((item, index) => {
                const card = document.createElement('div');
                card.className = 'bg-white p-3 rounded-md shadow-sm border border-gray-200 relative group';
                card.innerHTML = \`
                    <button class="absolute top-2 right-2 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity" onclick="removeFeedback(\${index})">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                        </svg>
                    </button>
                    <div class="text-xs text-gray-500 mb-1 italic truncate border-l-2 border-yellow-400 pl-2 bg-yellow-50 py-1">
                        "\${item.selectedText}"
                    </div>
                    <div class="text-sm text-gray-800 mt-2 font-medium">
                        \${item.comment}
                    </div>
                \`;
                listEl.appendChild(card);
            });
        }

        // Submit to backend
        document.getElementById('submit-btn').addEventListener('click', async () => {
            const btn = document.getElementById('submit-btn');
            const originalText = btn.innerHTML;
            
            btn.innerHTML = \`<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Submitting...\`;
            btn.disabled = true;
            
            try {
                const response = await fetch('/api/feedback', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(feedbackList)
                });
                
                if (response.ok) {
                    document.body.innerHTML = \`
                        <div class="h-screen w-full flex items-center justify-center bg-gray-50 flex-col">
                            <svg class="h-16 w-16 text-green-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <h1 class="text-2xl font-bold text-gray-800">Feedback Submitted!</h1>
                            <p class="text-gray-500 mt-2">Forge has received your notes. You can close this tab safely.</p>
                        </div>
                    \`;
                } else {
                    throw new Error("Server rejected submission");
                }
            } catch (err) {
                alert("Failed to submit feedback: " + err.message);
                btn.innerHTML = originalText;
                btn.disabled = false;
            }
        });

        // Init
        loadArtifact();
    </script>
</body>
</html>`;
}
