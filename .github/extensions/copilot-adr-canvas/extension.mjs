import { createServer } from "node:http";
import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webIndexPath = path.join(__dirname, "web", "index.html");
const servers = new Map();
const instances = new Map();
let runtimeSession = null;

class ApiError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

function toISODate(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function unquote(value) {
    const text = String(value || "").trim();
    const quoted = text.match(/^"(.*)"$/) || text.match(/^'(.*)'$/);
    return quoted ? quoted[1] : text;
}

function normalizeNewlines(value) {
    return String(value || "").replace(/\r\n/g, "\n");
}

function slugify(input) {
    return String(input)
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
}

function ensureUnderRoot(rootPath, relativePath) {
    const absolute = path.resolve(rootPath, relativePath);
    const normalizedRoot = path.resolve(rootPath);
    const rootWithSeparator = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
    if (absolute !== normalizedRoot && !absolute.startsWith(rootWithSeparator)) {
        throw new ApiError(400, "Path is outside the ADR root.");
    }
    return absolute;
}

function computeHash(content) {
    return createHash("sha256").update(String(content || ""), "utf8").digest("hex");
}

function resolveAdrRootPath(workingDirectory) {
    const baseDir = String(workingDirectory || process.cwd());
    return path.resolve(baseDir, "docs", "adr");
}

function resolveWorkspaceRoot(workingDirectory) {
    return path.resolve(String(workingDirectory || process.cwd()));
}

function resolvePreferencesPath() {
    const workspacePath = runtimeSession?.workspacePath;
    const baseDir = workspacePath || process.cwd();
    return path.join(baseDir, "copilot-adr-canvas-preferences.json");
}

function parseFrontMatter(markdown) {
    const normalized = normalizeNewlines(markdown);
    if (!normalized.startsWith("---\n")) return { hasFrontMatter: false, metadata: {}, body: normalized };

    const end = normalized.indexOf("\n---\n", 4);
    if (end === -1) return { hasFrontMatter: false, metadata: {}, body: normalized };

    const block = normalized.slice(4, end).split("\n");
    const metadata = {};
    for (const line of block) {
        const separator = line.indexOf(":");
        if (separator < 1) continue;
        const key = line.slice(0, separator).trim().toLowerCase();
        const value = unquote(line.slice(separator + 1));
        if (key) metadata[key] = value;
    }

    return {
        hasFrontMatter: true,
        metadata,
        body: normalized.slice(end + 5),
    };
}

function serializeFrontMatter(metadata, body) {
    const entries = Object.entries(metadata)
        .filter(([, value]) => value != null && String(value).trim().length > 0)
        .map(([key, value]) => `${key}: ${String(value).trim()}`);
    return `---\n${entries.join("\n")}\n---\n\n${normalizeNewlines(body).replace(/^\n+/, "")}`;
}

function extractFilenameInfo(relativePath) {
    const basename = path.basename(relativePath);
    const stem = basename.replace(/\.md$/i, "");
    const numbered = stem.match(/^(?:ADR-)?(\d{4,5})[-_](.+)$/i);
    if (!numbered) {
        return {
            basename,
            stem,
            number: "",
            titleFromFilename: stem.replace(/[-_]+/g, " ").trim(),
            adrFilenameCompatible: false,
        };
    }

    return {
        basename,
        stem,
        number: numbered[1],
        titleFromFilename: numbered[2].replace(/[-_]+/g, " ").trim(),
        adrFilenameCompatible: /^ADR-\d{4}[-_].+\.md$/i.test(basename),
    };
}

function splitByH2Sections(markdown) {
    const lines = normalizeNewlines(markdown).split("\n");
    const sections = {};
    let current = "__preamble";
    sections[current] = [];

    for (const line of lines) {
        const heading = line.match(/^##\s+(.+?)\s*$/);
        if (heading) {
            current = heading[1].trim().toLowerCase();
            if (!sections[current]) sections[current] = [];
            continue;
        }
        sections[current].push(line);
    }
    return sections;
}

function firstNonEmptyLine(lines = []) {
    for (const line of lines) {
        const value = String(line || "").trim();
        if (value) return value;
    }
    return "";
}

function analyzeAdr(relativePath, content) {
    const normalized = normalizeNewlines(content);
    const front = parseFrontMatter(normalized);
    const filename = extractFilenameInfo(relativePath);
    const sourceForSections = front.hasFrontMatter ? front.body : normalized;
    const sections = splitByH2Sections(sourceForSections);
    const h1 =
        sourceForSections.match(/^#\s+ADR-(\d{4,5})\s*:\s*(.+)\s*$/im) ||
        sourceForSections.match(/^#\s+(\d+)\.\s+(.+)\s*$/m);
    const dateLine = sourceForSections.match(/^Date:\s*(.+)\s*$/m);
    const sectionStatus = firstNonEmptyLine(sections.status);
    const hasAdrSections = Boolean(sections.status && sections.context && sections.decision && sections.consequences);
    const hasAdrToolsSections = Boolean(
        sections.status &&
        sections.context &&
        sections.options &&
        sections.decision &&
        sections.consequences
    );

    const title =
        String(front.metadata.title || "").trim() ||
        String(h1?.[2] || "").trim() ||
        filename.titleFromFilename ||
        filename.stem;

    const number = String(h1?.[1] || filename.number || "").trim();
    const displayTitle = number ? `${number}. ${title}` : title;

    const status = String(unquote(front.metadata.status || sectionStatus || "Unknown")).trim();
    const date = String(front.metadata.date || dateLine?.[1] || "").trim();

    const adrToolsCompatible =
        filename.adrFilenameCompatible &&
        Boolean(h1?.[1]) &&
        (!filename.number || Number(h1[1]) === Number(filename.number)) &&
        hasAdrToolsSections &&
        Boolean(sectionStatus);

    const isAdr =
        Boolean(filename.number) ||
        Boolean(front.metadata.status) ||
        Boolean(front.metadata.title) ||
        Boolean(front.metadata.date) ||
        hasAdrSections ||
        Boolean(h1?.[1]);

    return {
        normalizedContent: normalized,
        front,
        title,
        displayTitle,
        number,
        status,
        date,
        adrToolsCompatible,
        isAdr,
    };
}

function updateAdrToolsStatus(markdown, nextStatus) {
    const normalized = normalizeNewlines(markdown);
    const lines = normalized.split("\n");
    const statusStart = lines.findIndex((line) => /^##\s+Status\s*$/i.test(line));
    if (statusStart === -1) return null;

    let statusEnd = statusStart + 1;
    while (statusEnd < lines.length && !/^##\s+/.test(lines[statusEnd])) {
        statusEnd += 1;
    }

    const updatedLines = [
        ...lines.slice(0, statusStart),
        "## Status",
        "",
        nextStatus,
        "",
        ...lines.slice(statusEnd),
    ];

    return updatedLines.join("\n").replace(/\n{3,}/g, "\n\n");
}

async function listMarkdownFiles(dirPath, collector = []) {
    if (!existsSync(dirPath)) return collector;
    const entries = await readdir(dirPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const absolute = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            await listMarkdownFiles(absolute, collector);
            continue;
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
            collector.push(absolute);
        }
    }
    return collector;
}

async function listAdrs(rootPath, options = {}) {
    const includeNonAdr = Boolean(options.includeNonAdr);
    const query = String(options.query || "").toLowerCase().trim();
    const status = String(options.status || "").toLowerCase().trim();
    const files = await listMarkdownFiles(rootPath);
    const rows = [];

    for (const absolute of files) {
        const relative = path.relative(rootPath, absolute);
        const content = await readFile(absolute, "utf8");
        const adr = analyzeAdr(relative, content);
        if (!adr.isAdr && !includeNonAdr) continue;

        const haystack = `${relative} ${adr.title} ${adr.displayTitle} ${adr.status} ${content.slice(0, 500)}`.toLowerCase();
        if (query && !haystack.includes(query)) continue;
        if (status && adr.status.toLowerCase() !== status) continue;

        const fileInfo = await stat(absolute);
        rows.push({
            path: relative.split(path.sep).join("/"),
            name: path.basename(relative),
            title: adr.title,
            displayTitle: adr.displayTitle,
            number: adr.number,
            status: adr.status,
            date: adr.date,
            modified: fileInfo.mtime.toISOString(),
            sizeBytes: fileInfo.size,
            isAdr: adr.isAdr,
            compatible: adr.adrToolsCompatible,
        });
    }

    rows.sort((a, b) => a.path.localeCompare(b.path));
    return rows;
}

async function readAdr(rootPath, relativePath) {
    const absolutePath = ensureUnderRoot(rootPath, relativePath);
    const content = await readFile(absolutePath, "utf8");
    const adr = analyzeAdr(relativePath, content);
    return {
        path: relativePath.split(path.sep).join("/"),
        content: adr.normalizedContent,
        metadata: {
            ...adr.front.metadata,
            title: adr.title,
            status: adr.status,
            date: adr.date,
            compatible: adr.adrToolsCompatible,
        },
        hash: computeHash(adr.normalizedContent),
    };
}

async function saveAdr(rootPath, relativePath, content, expectedHash) {
    if (!String(relativePath || "").trim()) {
        throw new ApiError(400, "A file path is required.");
    }
    const absolutePath = ensureUnderRoot(rootPath, relativePath);
    const existing = await readFile(absolutePath, "utf8");
    if (expectedHash) {
        const currentHash = computeHash(normalizeNewlines(existing));
        if (currentHash !== expectedHash) {
            throw new ApiError(409, "This ADR changed on disk. Reload before saving.");
        }
    }
    await writeFile(absolutePath, normalizeNewlines(content), "utf8");
    return readAdr(rootPath, relativePath);
}

async function createAdr(rootPath, payload = {}) {
    const title = String(payload.title || "").trim();
    if (!title) throw new ApiError(400, "Title is required.");
    const status = String(payload.status || "Proposed").trim();
    const context = String(payload.context || "").trim();
    const options = String(payload.options || "").trim();
    const decision = String(payload.decision || "").trim();

    await mkdir(rootPath, { recursive: true });
    const files = await listMarkdownFiles(rootPath);
    const maxNumber = files.reduce((max, absolute) => {
        const match = path.basename(absolute).match(/^(?:ADR-)?(\d{4,5})[-_]/i);
        const number = match ? Number(match[1]) : 0;
        return Number.isFinite(number) && number > max ? number : max;
    }, 0);

    const nextNumber = String(maxNumber + 1).padStart(4, "0");
    const fileSlug = slugify(title) || "untitled-adr";
    const relativePath = `ADR-${nextNumber}-${fileSlug}.md`;
    const absolutePath = ensureUnderRoot(rootPath, relativePath);

    const fullTitle = `ADR-${nextNumber}: ${title}`;
    const content = normalizeNewlines(`---
title: "${fullTitle}"
date: "${toISODate()}"
status: "${status}"
---

# ${fullTitle}

## Status

${status}

## Context

${context || "Describe the problem and constraints."}

## Options

${options || "- Option A\\n- Option B"}

## Decision

${decision || "Describe the selected option and rationale."}

## Consequences

- Positive:
- Negative:
`);

    await writeFile(absolutePath, content, "utf8");
    return readAdr(rootPath, relativePath);
}

async function updateAdrStatus(rootPath, relativePath, status, expectedHash) {
    const nextStatus = String(status || "").trim();
    if (!nextStatus) throw new ApiError(400, "Status is required.");

    const absolutePath = ensureUnderRoot(rootPath, relativePath);
    const existingContent = normalizeNewlines(await readFile(absolutePath, "utf8"));
    if (expectedHash) {
        const currentHash = computeHash(existingContent);
        if (currentHash !== expectedHash) {
            throw new ApiError(409, "This ADR changed on disk. Reload before updating status.");
        }
    }

    const front = parseFrontMatter(existingContent);
    let updatedContent = "";

    if (front.hasFrontMatter) {
        updatedContent = serializeFrontMatter(
            {
                ...front.metadata,
                status: nextStatus,
                date: front.metadata.date || toISODate(),
                title: front.metadata.title || analyzeAdr(relativePath, existingContent).title,
            },
            front.body
        );
    } else {
        updatedContent = updateAdrToolsStatus(existingContent, nextStatus);
        if (!updatedContent) {
            throw new ApiError(400, "Could not locate a '## Status' section in this ADR.");
        }
    }

    await writeFile(absolutePath, updatedContent, "utf8");
    return readAdr(rootPath, relativePath);
}

async function readPreferences() {
    const preferencesPath = resolvePreferencesPath();
    if (!existsSync(preferencesPath)) return { search: "", statusFilter: "", theme: "auto", includeNonAdr: false };
    try {
        const raw = await readFile(preferencesPath, "utf8");
        const parsed = JSON.parse(raw);
        return {
            search: String(parsed.search || ""),
            statusFilter: String(parsed.statusFilter || ""),
            theme: String(parsed.theme || "auto"),
            includeNonAdr: Boolean(parsed.includeNonAdr),
        };
    } catch {
        return { search: "", statusFilter: "", theme: "auto", includeNonAdr: false };
    }
}

async function writePreferences(nextPreferences) {
    const preferencesPath = resolvePreferencesPath();
    const current = await readPreferences();
    const merged = {
        search: String(nextPreferences.search ?? current.search ?? ""),
        statusFilter: String(nextPreferences.statusFilter ?? current.statusFilter ?? ""),
        theme: String(nextPreferences.theme ?? current.theme ?? "auto"),
        includeNonAdr: Boolean(nextPreferences.includeNonAdr ?? current.includeNonAdr ?? false),
    };
    await writeFile(preferencesPath, JSON.stringify(merged, null, 2), "utf8");
    return merged;
}

async function buildWorkflowInventory(rootPath) {
    const items = await listAdrs(rootPath, {});
    const rows = items
        .filter((item) => item.number)
        .sort((a, b) => Number(a.number) - Number(b.number))
        .map((item) => `| ${item.number} | ${item.title} | ${item.status || "Unknown"} | ${item.date || ""} |`);
    const tableHeader = [
        "| # | Title | Status | Date |",
        "|---|-------|--------|------|",
    ];
    return [...tableHeader, ...rows].join("\n");
}

async function generateAiAdrWorkflow(rootPath, workspaceRoot) {
    await mkdir(rootPath, { recursive: true });
    const inventoryTable = await buildWorkflowInventory(rootPath);
    const content = normalizeNewlines(`# ADR AI Workflow

> Auto-generated by Markdown Copilot ADR Canvas. You can edit this file; the inventory section is auto-refreshed.

## Conventions
- ADR folder: docs/adr
- Filename pattern: ADR-NNNN-title-with-dashes.md (4-digit zero-padded)
- Front matter fields: title, date, status
- Status lifecycle: Proposed -> Accepted -> Deprecated / Superseded / Rejected
- Numbering rule: use next max number + 1; never renumber existing ADRs

## Nygard Template (example)

\`\`\`markdown
---
title: "ADR-0000: Decision title"
date: "YYYY-MM-DD"
status: "Proposed"
---

# ADR-0000: Decision title

## Status

Proposed

## Context

Describe constraints and forces.

## Options

- Option A
- Option B

## Decision

State the chosen option and rationale.

## Consequences

- Positive outcomes
- Trade-offs
\`\`\`

## AI prompt examples
1. "Create a new ADR about [decision] using ADR-NNNN filename convention and the Nygard template."
2. "Review docs/adr and suggest which Proposed ADRs should be Accepted, with rationale."
3. "Summarize decision history for [topic] using ADR number, title, status, and consequences."
4. "Check ADRs for missing Options or weak Consequences and suggest improvements."

## What AI should do
1. Create ADRs with the template and naming convention above.
2. Review ADRs for missing context, weak options, and unclear consequences.
3. Reference ADR number and title when answering decision-history questions.
4. Never update ADR status without explicit user instruction.

## Current ADRs

<!-- ADR_INVENTORY_START -->
${inventoryTable}
<!-- ADR_INVENTORY_END -->
`);
    const filePath = path.join(workspaceRoot, "AI_ADR_WORKFLOW.md");
    await writeFile(filePath, content, "utf8");
    return {
        path: "AI_ADR_WORKFLOW.md",
        absolutePath: filePath,
    };
}

function writeJson(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
}

async function handleApi(req, res, instanceId) {
    const state = instances.get(instanceId);
    if (!state) {
        writeJson(res, 404, { error: "Canvas instance was not initialized." });
        return;
    }

    const url = new URL(req.url || "/", "http://127.0.0.1");
    const route = url.pathname;

    try {
        if (req.method === "GET" && route === "/api/state") {
            const preferences = await readPreferences();
            writeJson(res, 200, {
                rootPath: state.rootPath,
                rootPathDisplay: "docs/adr",
                preferences,
            });
            return;
        }

        if (req.method === "GET" && route === "/api/list") {
            const data = await listAdrs(state.rootPath, {
                query: url.searchParams.get("q") || "",
                status: url.searchParams.get("status") || "",
                includeNonAdr: url.searchParams.get("includeNonAdr") === "1",
            });
            writeJson(res, 200, { items: data });
            return;
        }

        if (req.method === "GET" && route === "/api/file") {
            const relativePath = String(url.searchParams.get("path") || "");
            if (!relativePath) throw new ApiError(400, "Query parameter 'path' is required.");
            const data = await readAdr(state.rootPath, relativePath);
            writeJson(res, 200, data);
            return;
        }

        if (req.method === "POST" && route === "/api/file") {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || "{}");
            const data = await saveAdr(state.rootPath, payload.path, payload.content, payload.expectedHash);
            writeJson(res, 200, data);
            return;
        }

        if (req.method === "POST" && route === "/api/create") {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || "{}");
            const data = await createAdr(state.rootPath, payload);
            writeJson(res, 200, data);
            return;
        }

        if (req.method === "POST" && route === "/api/status") {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || "{}");
            const data = await updateAdrStatus(state.rootPath, payload.path, payload.status, payload.expectedHash);
            writeJson(res, 200, data);
            return;
        }

        if (req.method === "POST" && route === "/api/preferences") {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || "{}");
            const preferences = await writePreferences(payload || {});
            writeJson(res, 200, { preferences });
            return;
        }

        if (req.method === "POST" && route === "/api/generate-workflow") {
            const generated = await generateAiAdrWorkflow(state.rootPath, state.workspaceRoot);
            writeJson(res, 200, generated);
            return;
        }

        writeJson(res, 404, { error: "Not found." });
    } catch (error) {
        const statusCode = error instanceof ApiError ? error.statusCode : 400;
        writeJson(res, statusCode, { error: error instanceof Error ? error.message : "Unexpected request error." });
    }
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

async function startServer(instanceId) {
    const html = await readFile(webIndexPath, "utf8");
    const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        if (url.pathname.startsWith("/api/")) {
            await handleApi(req, res, instanceId);
            return;
        }

        if (url.pathname === "/" || url.pathname === "/index.html") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(html);
            return;
        }

        res.statusCode = 404;
        res.end("Not found");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

const canvas = createCanvas({
    id: "copilot-adr-canvas",
    displayName: "Markdown Copilot ADR Canvas",
    description: "Browse, preview, edit, and create markdown ADRs inside the Copilot canvas.",
    actions: [
        {
            name: "list_adrs",
            description: "List ADR markdown files and metadata for the active root path.",
            inputSchema: {
                type: "object",
                properties: {
                    query: { type: "string" },
                    status: { type: "string" },
                    includeNonAdr: { type: "boolean" },
                },
            },
            handler: async (ctx) => {
                const state = instances.get(ctx.instanceId);
                if (!state) throw new CanvasError("canvas_state_missing", "Canvas instance not found.");
                return {
                    rootPath: state.rootPath,
                    items: await listAdrs(state.rootPath, ctx.input || {}),
                };
            },
        },
        {
            name: "create_adr",
            description: "Create a new adr-tools compatible markdown ADR file.",
            inputSchema: {
                type: "object",
                properties: {
                    title: { type: "string" },
                    status: { type: "string" },
                    context: { type: "string" },
                    options: { type: "string" },
                    decision: { type: "string" },
                },
                required: ["title"],
            },
            handler: async (ctx) => {
                const state = instances.get(ctx.instanceId);
                if (!state) throw new CanvasError("canvas_state_missing", "Canvas instance not found.");
                return createAdr(state.rootPath, ctx.input || {});
            },
        },
        {
            name: "update_adr_status",
            description: "Update an ADR status in front matter or adr-tools status section.",
            inputSchema: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    status: { type: "string" },
                    expectedHash: { type: "string" },
                },
                required: ["path", "status"],
            },
            handler: async (ctx) => {
                const state = instances.get(ctx.instanceId);
                if (!state) throw new CanvasError("canvas_state_missing", "Canvas instance not found.");
                return updateAdrStatus(state.rootPath, ctx.input.path, ctx.input.status, ctx.input.expectedHash);
            },
        },
    ],
    open: async (ctx) => {
        if (ctx.input && Object.keys(ctx.input).length > 0) {
            throw new CanvasError("canvas_input_invalid", "This canvas is fixed to docs/adr in the active workspace.");
        }

        const workspaceRoot = resolveWorkspaceRoot(ctx.session?.workingDirectory);
        const rootPath = resolveAdrRootPath(ctx.session?.workingDirectory);
        instances.set(ctx.instanceId, { rootPath, workspaceRoot });

        let entry = servers.get(ctx.instanceId);
        if (!entry) {
            entry = await startServer(ctx.instanceId);
            servers.set(ctx.instanceId, entry);
        }

        return {
            title: "Markdown Copilot ADR Canvas",
            url: entry.url,
        };
    },
    onClose: async (ctx) => {
        instances.delete(ctx.instanceId);
        const entry = servers.get(ctx.instanceId);
        if (entry) {
            servers.delete(ctx.instanceId);
            await new Promise((resolve) => entry.server.close(() => resolve()));
        }
    },
});

runtimeSession = await joinSession({
    canvases: [canvas],
});
