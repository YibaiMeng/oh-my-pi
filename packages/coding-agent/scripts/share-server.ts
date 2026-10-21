#!/usr/bin/env bun
/**
 * Self-hostable `/share` server: the blob store and viewer behind
 * `share.serverUrl` (default `https://my.omp.sh/s`).
 *
 * - `POST /s` stores a sealed blob and answers `{"id": "<id>"}`.
 * - `GET /s/<id>` serves the viewer page from `generate-share-viewer.ts`.
 * - `GET /s/<id>/raw` serves the sealed blob the viewer decrypts.
 * - `GET /healthz` answers `ok`.
 *
 * Content-blind: blobs are AES-256-GCM sealed by the client and the key
 * lives in the link's `#fragment`, which browsers never send. The viewer
 * page carries a CSP that confines every fetch, script, image, and font to
 * this origin. Runtime needs only Bun: no native addon, no repo imports.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

/** Mirrors `SERVER_MAX_SEALED_BYTES` in `src/export/share.ts`; the client trims snapshots to fit. */
export const DEFAULT_SHARE_MAX_BYTES = 1_000_000;
const DEFAULT_PORT = 7480;

/** Same id shape `share.ts` accepts from `POST /s`. */
const SHARE_PATH_RE = /^\/s\/([A-Za-z0-9_-]{10,64})(\/raw)?\/?$/;
/** The viewer routes pure-hex ids to GitHub gists, so the store never issues one. */
const HEX_ID_RE = /^[0-9a-f]+$/;

/**
 * Same-origin only. Inline scripts stay allowed (the viewer uses inline
 * handlers); `connect-src 'self'` permits the `/s/<id>/raw` fetch and blocks
 * the viewer's GitHub gist fetch.
 */
const VIEWER_HEADERS = {
	"content-type": "text/html; charset=utf-8",
	"content-security-policy": [
		"default-src 'none'",
		"script-src 'self' 'unsafe-inline'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		"connect-src 'self'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join("; "),
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
};

export interface ShareServerOptions {
	/** Directory holding uploaded sealed blobs; created if missing. */
	dir: string;
	/** Viewer page from `scripts/generate-share-viewer.ts`. */
	viewerHtmlPath: string;
	/** 0 picks a free port. */
	port?: number;
	/** Bind address; Bun's default (all interfaces) when omitted. */
	hostname?: string;
	/** Upload cap in bytes; defaults to {@link DEFAULT_SHARE_MAX_BYTES}. */
	maxBytes?: number;
}

export interface ShareServer {
	/** Value for `share.serverUrl`, e.g. `http://localhost:7480/s`. */
	url: string;
	stop(): void;
}

export function startShareServer(options: ShareServerOptions): ShareServer {
	const dir = path.resolve(options.dir);
	const viewerHtml = fs.readFileSync(options.viewerHtmlPath, "utf8");
	const maxBytes = options.maxBytes ?? DEFAULT_SHARE_MAX_BYTES;
	fs.mkdirSync(dir, { recursive: true });

	const server = Bun.serve({
		port: options.port ?? 0,
		hostname: options.hostname,
		// Bun answers 413 itself past this; storeShare re-checks the exact cap.
		maxRequestBodySize: maxBytes,
		fetch(req): Response | Promise<Response> {
			const { pathname } = new URL(req.url);
			if (pathname === "/healthz") return new Response("ok");
			if (pathname === "/s" || pathname === "/s/") {
				if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
				return storeShare(req, dir, maxBytes);
			}
			const match = SHARE_PATH_RE.exec(pathname);
			if (!match) return new Response("not found", { status: 404 });
			if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
			if (match[2]) return serveBlob(path.join(dir, match[1]!));
			// The viewer fetches `/s/<id>/raw` itself and reports a missing share.
			return new Response(viewerHtml, { headers: VIEWER_HEADERS });
		},
	});

	return {
		url: `http://localhost:${server.port}/s`,
		stop(): void {
			server.stop(true);
		},
	};
}

async function storeShare(req: Request, dir: string, maxBytes: number): Promise<Response> {
	if (Number(req.headers.get("content-length") ?? 0) > maxBytes) {
		return new Response("share too large", { status: 413 });
	}
	const body = new Uint8Array(await req.arrayBuffer());
	if (body.byteLength === 0) return new Response("empty share", { status: 400 });
	if (body.byteLength > maxBytes) return new Response("share too large", { status: 413 });
	let id: string;
	do {
		id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
	} while (HEX_ID_RE.test(id));
	await Bun.write(path.join(dir, id), body);
	return Response.json({ id });
}

async function serveBlob(file: string): Promise<Response> {
	try {
		if (!(await fs.promises.stat(file)).isFile()) throw new Error("not a file");
	} catch {
		return new Response("share not found", { status: 404 });
	}
	return new Response(Bun.file(file), {
		headers: { "content-type": "application/octet-stream", "x-content-type-options": "nosniff" },
	});
}

function fail(message: string): never {
	console.error(`share-server: ${message}`);
	process.exit(1);
}

function parseIntArg(name: string, raw: string | undefined, fallback: number, max: number): number {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0 || value > max) fail(`invalid --${name} ${raw}`);
	return value;
}

if (import.meta.main) {
	let values: Record<string, string | undefined>;
	try {
		({ values } = parseArgs({
			args: Bun.argv.slice(2),
			options: {
				dir: { type: "string" },
				viewer: { type: "string" },
				port: { type: "string" },
				host: { type: "string" },
				"max-bytes": { type: "string" },
			},
		}));
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
	if (!values.dir || !values.viewer) {
		fail(
			"usage: bun scripts/share-server.ts --dir <blob dir> --viewer <share-viewer.html> [--port 7480] [--host addr] [--max-bytes n]",
		);
	}
	const server = startShareServer({
		dir: values.dir,
		viewerHtmlPath: values.viewer,
		port: parseIntArg("port", values.port, DEFAULT_PORT, 65_535),
		hostname: values.host,
		maxBytes: parseIntArg("max-bytes", values["max-bytes"], DEFAULT_SHARE_MAX_BYTES, Number.MAX_SAFE_INTEGER),
	});
	console.log(`share server listening; set share.serverUrl to ${server.url} (or your public origin + /s)`);
	console.log(`  blobs   ${path.resolve(values.dir)}`);
	const shutdown = (): void => {
		server.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
