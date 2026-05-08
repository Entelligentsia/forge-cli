// Foundry collision detection — Q17 (FORGE-S16-T02).
//
// Detects whether another `forge` binary is shadowing our own and provides
// a one-time dismissal cache at ~/.cache/forgecli/seen.json.
//
// All file I/O is silently no-op on any error (never throws to caller).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface CollisionResult {
	collides: boolean;
	colliderPath: string | null;
}

/**
 * Detect whether a `forge` binary other than ourselves is on PATH.
 *
 * Collision = `which forge` resolves to a path whose realpath is NOT under
 * the same ancestor directory as `process.argv[1]` (our own binary).
 *
 * Uses `spawnSync("which", ["forge"])` with argv array — Iron Law 6.
 * Returns `{ collides: false, colliderPath: null }` on any error.
 */
export function detectFoundryCollision(): CollisionResult {
	try {
		const result = spawnSync("which", ["forge"], {
			encoding: "utf8",
			timeout: 5000,
		});

		if (result.status !== 0 || !result.stdout) {
			// `which` found nothing or failed — no collision
			return { collides: false, colliderPath: null };
		}

		const whichPath = result.stdout.trim();
		if (!whichPath) return { collides: false, colliderPath: null };

		// Resolve realpaths to dereference symlinks
		let resolvedWhich: string;
		let resolvedSelf: string;
		try {
			resolvedWhich = fs.realpathSync(whichPath);
			resolvedSelf = fs.realpathSync(process.argv[1] ?? "");
		} catch {
			// Cannot resolve — conservatively report no collision
			return { collides: false, colliderPath: null };
		}

		if (resolvedWhich === resolvedSelf) {
			// `which forge` points at us — no collision
			return { collides: false, colliderPath: null };
		}

		return { collides: true, colliderPath: whichPath };
	} catch {
		return { collides: false, colliderPath: null };
	}
}

// ---------------------------------------------------------------------------
// Dismissal cache
// ---------------------------------------------------------------------------

interface SeenJson {
	collisions: Record<string, boolean>;
}

function seenJsonPath(): string {
	return path.join(os.homedir(), ".cache", "forgecli", "seen.json");
}

function readSeenJson(): SeenJson {
	try {
		const raw = fs.readFileSync(seenJsonPath(), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && "collisions" in parsed) {
			return parsed as SeenJson;
		}
	} catch {
		// Missing or malformed — treat as empty
	}
	return { collisions: {} };
}

/**
 * Returns true if this collider path has already been dismissed by the user.
 * Returns false on any error (conservative: show the notification again).
 */
export function wasCollisionSeen(colliderPath: string): boolean {
	try {
		const seen = readSeenJson();
		return seen.collisions[colliderPath] === true;
	} catch {
		return false;
	}
}

/**
 * Mark a collider path as seen so the one-time notification is not repeated.
 * Silent no-op on any error.
 */
export function markCollisionSeen(colliderPath: string): void {
	try {
		const cacheDir = path.dirname(seenJsonPath());
		fs.mkdirSync(cacheDir, { recursive: true });

		const seen = readSeenJson();
		seen.collisions[colliderPath] = true;
		fs.writeFileSync(seenJsonPath(), JSON.stringify(seen, null, 2), "utf8");
	} catch {
		// Silent no-op
	}
}
