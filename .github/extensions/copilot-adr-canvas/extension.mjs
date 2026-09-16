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

const DEFAULT_ADR_FOLDER = "docs/adr";
const WORKFLOW_FILENAME = "ADR_AI_WORKFLOW.md";
const ADR_STATUSES = ["Proposed", "Accepted", "Rejected", "Superseded", "Deprecated", "Draft"];

function resolveAdrRootPath(workingDirectory, adrFolder) {
    const baseDir = String(workingDirectory || process.cwd());
    const folder = String(adrFolder || DEFAULT_ADR_FOLDER).trim() || DEFAULT_ADR_FOLDER;
    return path.resolve(baseDir, ...folder.split(/[/\\]+/).filter(Boolean));
}

function resolveWorkspaceRoot(workingDirectory) {
    return path.resolve(String(workingDirectory || process.cwd()));
}

function resolveAdrRoots(session, adrFolder) {
    const workspaceFolders = session?.workspaceFolders;
    if (Array.isArray(workspaceFolders) && workspaceFolders.length > 0) {
        const roots = workspaceFolders
            .map((folder) => {
                const folderPath = typeof folder === "string"
                    ? folder
                    : String(folder?.path || folder?.uri || "");
                if (!folderPath) return null;
                const workspaceRoot = path.resolve(folderPath);
                return {
                    workspaceRoot,
                    rootPath: resolveAdrRootPath(workspaceRoot, adrFolder),
                    label: path.basename(workspaceRoot),
                };
            })
            .filter(Boolean);
        if (roots.length > 0) return roots;
    }
    const workspaceRoot = resolveWorkspaceRoot(session?.workingDirectory);
    return [{
        workspaceRoot,
        rootPath: resolveAdrRootPath(session?.workingDirectory, adrFolder),
        label: path.basename(workspaceRoot),
    }];
}

function getActiveRoot(state) {
    return state.roots[state.activeIndex ?? 0];
}

function getRootPathDisplay(state) {
    const activeRoot = getActiveRoot(state);
    return path.relative(activeRoot.workspaceRoot, activeRoot.rootPath).split(path.sep).join("/") || ".";
}

function resolvePreferencesPath() {
    const workspacePath = runtimeSession?.workspacePath;
    const baseDir = workspacePath || process.cwd();
    return path.join(baseDir, "copilot-adr-canvas-preferences.json");
}

function parseFrontMatter(markdown) {
    const normalized = normalizeNewlines(markdown);
    if (!normalized.startsWith("---")) return { hasFrontMatter: false, metadata: {}, body: normalized };

    const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
    if (!match) {
        throw new ApiError(400, "Malformed front matter: opening '---' found without closing delimiter.");
    }

    const block = match[1].split("\n");
    const metadata = {};
    for (const line of block) {
        const parsed = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
        if (!parsed) continue;
        const key = parsed[1].trim().toLowerCase();
        const value = unquote(parsed[2]);
        if (key) metadata[key] = value;
    }

    return {
        hasFrontMatter: true,
        metadata,
        body: match[2] || "",
    };
}

function toYamlScalar(value) {
    const raw = String(value ?? "");
    return `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function serializeFrontMatter(metadata, body) {
    const orderedKeys = ["title", "date", "status"];
    const otherKeys = Object.keys(metadata || {})
        .filter((key) => !orderedKeys.includes(key))
        .sort((a, b) => a.localeCompare(b));
    const entries = orderedKeys
        .filter((key) => metadata?.[key] != null && String(metadata[key]).trim().length > 0)
        .concat(otherKeys)
        .map((key) => `${key}: ${toYamlScalar(String(metadata[key]).trim())}`);
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
        adrFilenameCompatible: /^\d{4}-.+\.md$/i.test(basename),
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

function isLikelyAdrFile(relativePath, basename, title, markdown) {
    const joinedPath = `${String(relativePath || "")}/${String(basename || "")}`.toLowerCase();
    const lowerName = String(basename || "").toLowerCase();
    const lowerTitle = String(title || "").toLowerCase();
    const text = normalizeNewlines(markdown).replace(/^---\n[\s\S]*?\n---(?:\n)?/, "").toLowerCase();

    if (/(^|[/\\])(adr|adrs)([/\\]|$)/.test(joinedPath)) return true;
    if (/^adr[-_ ]?\d{1,5}/i.test(basename)) return true;
    if (/^0*\d{1,5}[-_]/.test(lowerName) && /(decision|architecture|adr)/.test(text)) return true;
    if (/^adr[-_:\s]?\d{1,5}/.test(lowerTitle)) return true;

    const hasContext = /(^|\n)#{1,6}\s+context\b/m.test(text);
    const hasDecision = /(^|\n)#{1,6}\s+decision\b/m.test(text);
    const hasConsequences = /(^|\n)#{1,6}\s+consequences?\b/m.test(text);
    const hasOptions = /(^|\n)#{1,6}\s+options?\b/m.test(text);
    const coreSections = Number(hasContext) + Number(hasDecision) + Number(hasConsequences) + Number(hasOptions);
    return coreSections >= 2;
}

function analyzeAdr(relativePath, content) {
    const normalized = normalizeNewlines(content);
    const front = parseFrontMatter(normalized);
    const filename = extractFilenameInfo(relativePath);
    const sourceForSections = front.hasFrontMatter ? front.body : normalized;
    const sections = splitByH2Sections(sourceForSections);
    const h1 =
        sourceForSections.match(/^#\s+(?:ADR-)?(\d{4,5})\s*:\s*(.+)\s*$/im) ||
        sourceForSections.match(/^#\s+(\d+)\.\s+(.+)\s*$/m) ||
        sourceForSections.match(/^#\s+(.+?)\s*$/m);
    const dateLine = sourceForSections.match(/^Date:\s*(.+)\s*$/m);
    const sectionStatus = firstNonEmptyLine(sections.status);

    const title =
        String(front.metadata.title || "").trim() ||
        String(h1?.[2] || h1?.[1] || "").trim() ||
        filename.titleFromFilename ||
        filename.stem;

    const number = String((h1?.[2] ? h1?.[1] : "") || filename.number || "").trim();
    const displayTitle = number ? `${number}. ${title}` : title;

    const status = String(unquote(front.metadata.status || sectionStatus || "Unknown")).trim();
    const date = String(front.metadata.date || dateLine?.[1] || "").trim();

    const adrToolsCompatible =
        filename.adrFilenameCompatible &&
        Boolean(front.metadata.status) &&
        Boolean(sections.context && sections.options && sections.decision && sections.consequences);

    const isAdr = isLikelyAdrFile(relativePath, filename.basename, title, normalized);

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
    if (!ADR_STATUSES.includes(status)) throw new ApiError(400, "Invalid ADR status value.");
    const folder = String(payload.folder || "").trim();
    const targetRoot = folder ? ensureUnderRoot(rootPath, folder) : rootPath;

    await mkdir(targetRoot, { recursive: true });
    const files = await listMarkdownFiles(targetRoot);
    const maxNumber = files.reduce((max, absolute) => {
        const match = path.basename(absolute).match(/^(\d{4})-/i);
        const number = match ? Number(match[1]) : 0;
        return Number.isFinite(number) && number > max ? number : max;
    }, 0);

    const nextNumber = String(maxNumber + 1).padStart(4, "0");
    const fileSlug = slugify(title) || "untitled-adr";
    const relativePath = folder ? path.join(folder, `${nextNumber}-${fileSlug}.md`) : `${nextNumber}-${fileSlug}.md`;
    const absolutePath = ensureUnderRoot(rootPath, relativePath);

    const content = normalizeNewlines(`---
title: ${toYamlScalar(title)}
date: ${toYamlScalar(toISODate())}
status: ${toYamlScalar(status)}
---

# ${title}

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
        updatedContent = serializeFrontMatter(
            {
                title: analyzeAdr(relativePath, existingContent).title,
                date: toISODate(),
                status: nextStatus,
            },
            existingContent
        );
    }

    await writeFile(absolutePath, updatedContent, "utf8");
    return readAdr(rootPath, relativePath);
}

async function readPreferences() {
    const preferencesPath = resolvePreferencesPath();
    if (!existsSync(preferencesPath)) return { search: "", statusFilter: "", theme: "auto", includeNonAdr: false, adrFolder: DEFAULT_ADR_FOLDER };
    try {
        const raw = await readFile(preferencesPath, "utf8");
        const parsed = JSON.parse(raw);
        return {
            search: String(parsed.search || ""),
            statusFilter: String(parsed.statusFilter || ""),
            theme: String(parsed.theme || "auto"),
            includeNonAdr: Boolean(parsed.includeNonAdr),
            adrFolder: String(parsed.adrFolder || DEFAULT_ADR_FOLDER),
        };
    } catch {
        return { search: "", statusFilter: "", theme: "auto", includeNonAdr: false, adrFolder: DEFAULT_ADR_FOLDER };
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
        adrFolder: String(nextPreferences.adrFolder ?? current.adrFolder ?? DEFAULT_ADR_FOLDER),
    };
    await writeFile(preferencesPath, JSON.stringify(merged, null, 2), "utf8");
    return merged;
}

async function buildWorkflowInventory(rootPath) {
    const items = await listAdrs(rootPath, {});
    const rows = items
        .filter((item) => item.number)
        .sort((a, b) => Number(a.number) - Number(b.number))
        .map((item) => `| ${escapeTableCell(item.number)} | \`${escapeTableCell(item.path)}\` | ${escapeTableCell(item.title || item.name)} | ${escapeTableCell(item.status || "Unknown")} | ${escapeTableCell(item.date || "-")} |`);
    const tableHeader = [
        "| # | File | Title | Status | Date |",
        "|---|---|---|---|---|",
    ];
    return [...tableHeader, ...(rows.length ? rows : ["| - | - | No ADRs found | - | - |"])].join("\n");
}

function escapeTableCell(value) {
    return String(value ?? "").replace(/\|/g, "\\|");
}

async function generateAiAdrWorkflow(rootPath, workspaceRoot) {
    await mkdir(rootPath, { recursive: true });
    const inventoryTable = await buildWorkflowInventory(rootPath);
    const adrFolder = path.relative(workspaceRoot, rootPath).split(path.sep).join("/") || DEFAULT_ADR_FOLDER;
    const adrFolderDisplay = adrFolder === "." ? "." : `${adrFolder.replace(/\/+$/, "")}/`;
    const content = normalizeNewlines(`---
status: "Accepted"
---

# ADR AI Workflow

> Auto-generated for Markdown Copilot ADR Canvas on ${toISODate()}.
> Read this file before creating, updating, or reviewing ADRs.

## Conventions

- **Recommended ADR folder:** \`${adrFolderDisplay}\`. Each project may choose and document its own ADR folder; this recommendation is not mandatory.
- **Filename pattern:** \`NNNN-title-with-dashes.md\` (4-digit zero-padded). Titles may include \`ADR\` or any other naming the project or user chooses; an \`ADR-\` prefix is not required.
- **Front matter fields:** \`title\`, \`date\` (YYYY-MM-DD), \`status\`
- **Status lifecycle:** \`Proposed\` → \`Accepted\` → \`Deprecated\` / \`Superseded\` / \`Rejected\`
- **Numbering:** use the next max number + 1; never renumber existing ADRs.

## Nygard Template (example)

\`\`\`markdown
---
title: <Decision title>
date: YYYY-MM-DD
status: Accepted
---

# <Decision title>

## Context

<Describe the situation, constraints, and forces at play.>

## Options

- Option A: <Description>
  - Pros: <...>
  - Cons: <...>
- Option B: <Description>
  - Pros: <...>
  - Cons: <...>

## Decision

<State the chosen option and why.>

## Consequences

<Describe outcomes, trade-offs, and follow-up implications.>
\`\`\`

Do not add a \`## Status\` section; status remains in YAML front matter.

## Lifecycle Guidance

- New ADRs default to \`Proposed\` unless the user explicitly requests another status.
- Never update an ADR status without explicit user instruction.
- Lifecycle changes modify only the front matter \`status\`; preserve existing ADR content unless the user asks for other changes.

## Prompt Examples

1. Create the next ADR in the recommended folder (\`${adrFolderDisplay}\`) for [decision], using the next max number + 1 and the Nygard template.
2. Review \`NNNN-title-with-dashes.md\` for missing sections, weak rationale, and unclear consequences; suggest improvements without changing the file.
3. Change the status of \`NNNN-title-with-dashes.md\` to \`Superseded\` and update only its front matter status.
4. Use the ADR inventory and existing ADR content to explain the decision history for [topic], citing the relevant NNNN filenames and titles.

## What AI Should Do

1. Create ADRs with the Nygard section structure and filename convention above.
2. Review ADRs for missing context, weak options, unclear decisions, and consequences.
3. Use the inventory and ADR contents to answer decision-history questions, citing relevant filenames and titles.
4. Preserve existing content and never make lifecycle or other edits without explicit user instruction.

## Current ADR Inventory

<!-- ADR_INVENTORY_START -->
${inventoryTable}
<!-- ADR_INVENTORY_END -->
`);
    const filePath = path.join(workspaceRoot, WORKFLOW_FILENAME);
    await writeFile(filePath, content, "utf8");
    return {
        path: WORKFLOW_FILENAME,
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
            const activeRoot = getActiveRoot(state);
            writeJson(res, 200, {
                rootPath: activeRoot.rootPath,
                rootPathDisplay: getRootPathDisplay(state),
                preferences,
                repos: state.roots.map((r, i) => ({ label: r.label, index: i })),
                activeRepoIndex: state.activeIndex ?? 0,
                multiRepo: state.roots.length > 1,
            });
            return;
        }

        if (req.method === "GET" && route === "/api/browse-dirs") {
            // List subdirectories of a path relative to workspace root.
            // Param: rel (relative path from workspace root, default ".")
            const rel = String(url.searchParams.get("rel") || ".").trim() || ".";
            const activeRoot = getActiveRoot(state);
            const absDir = path.isAbsolute(rel)
                ? null
                : path.resolve(activeRoot.workspaceRoot, rel);
            const wsNorm = path.resolve(activeRoot.workspaceRoot);
            if (!absDir || (absDir !== wsNorm && !absDir.startsWith(wsNorm + path.sep))) {
                throw new ApiError(400, "Path is outside the workspace.");
            }
            if (!existsSync(absDir)) {
                writeJson(res, 200, { rel: rel === "." ? "" : rel, dirs: [] });
                return;
            }
            const entries = await readdir(absDir, { withFileTypes: true });
            const dirs = entries
                .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((e) => {
                    const childRel = path.relative(wsNorm, path.join(absDir, e.name)).split(path.sep).join("/");
                    return { name: e.name, rel: childRel };
                });
            const currentRel = path.relative(wsNorm, absDir).split(path.sep).join("/") || ".";
            writeJson(res, 200, { rel: currentRel, dirs });
            return;
        }

        if (req.method === "POST" && route === "/api/change-folder") {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || "{}");
            const rawFolder = String(payload.adrFolder || "").trim();
            if (!rawFolder) throw new ApiError(400, "adrFolder is required.");

            // Reject absolute paths — must be relative to workspace root
            if (path.isAbsolute(rawFolder)) {
                throw new ApiError(400, "Folder must be a relative path (e.g. docs/adr or architecture/decisions).");
            }

            const nextRootPaths = state.roots.map((root) => {
                const newRootPath = resolveAdrRootPath(root.workspaceRoot, rawFolder);
                const wsNorm = path.resolve(root.workspaceRoot);
                if (!newRootPath.startsWith(wsNorm + path.sep) && newRootPath !== wsNorm) {
                    throw new ApiError(400, "Folder must be inside the workspace root.");
                }
                return newRootPath;
            });
            state.roots.forEach((root, index) => {
                root.rootPath = nextRootPaths[index];
            });
            const activeRoot = getActiveRoot(state);
            const prefs = await writePreferences({ adrFolder: rawFolder });
            writeJson(res, 200, {
                rootPath: activeRoot.rootPath,
                rootPathDisplay: getRootPathDisplay(state),
                preferences: prefs,
            });
            return;
        }

        if (req.method === "GET" && route === "/api/list") {
            const data = await listAdrs(getActiveRoot(state).rootPath, {
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
            const data = await readAdr(getActiveRoot(state).rootPath, relativePath);
            writeJson(res, 200, data);
            return;
        }

        if (req.method === "POST" && route === "/api/file") {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || "{}");
            const data = await saveAdr(getActiveRoot(state).rootPath, payload.path, payload.content, payload.expectedHash);
            writeJson(res, 200, data);
            return;
        }

        if (req.method === "POST" && route === "/api/create") {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || "{}");
            const data = await createAdr(getActiveRoot(state).rootPath, payload);
            writeJson(res, 200, data);
            return;
        }

        if (req.method === "POST" && route === "/api/status") {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || "{}");
            const data = await updateAdrStatus(getActiveRoot(state).rootPath, payload.path, payload.status, payload.expectedHash);
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
            const activeRoot = getActiveRoot(state);
            const generated = await generateAiAdrWorkflow(activeRoot.rootPath, activeRoot.workspaceRoot);
            writeJson(res, 200, generated);
            return;
        }

        if (req.method === "POST" && route === "/api/selectrepo") {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || "{}");
            const index = Number(payload.index);
            if (!Number.isFinite(index) || index < 0 || index >= state.roots.length) {
                throw new ApiError(400, "Invalid repo index.");
            }
            state.activeIndex = index;
            const activeRoot = getActiveRoot(state);
            writeJson(res, 200, {
                rootPath: activeRoot.rootPath,
                rootPathDisplay: getRootPathDisplay(state),
                activeRepoIndex: state.activeIndex,
            });
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
                const activeRoot = getActiveRoot(state);
                return {
                    rootPath: activeRoot.rootPath,
                    items: await listAdrs(activeRoot.rootPath, ctx.input || {}),
                };
            },
        },
        {
            name: "create_adr",
            description: "Create a new markdown ADR file using NNNN-title-with-dashes.md and front matter status.",
            inputSchema: {
                type: "object",
                properties: {
                    title: { type: "string" },
                    status: { type: "string" },
                    folder: { type: "string" },
                },
                required: ["title"],
            },
            handler: async (ctx) => {
                const state = instances.get(ctx.instanceId);
                if (!state) throw new CanvasError("canvas_state_missing", "Canvas instance not found.");
                return createAdr(getActiveRoot(state).rootPath, ctx.input || {});
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
                return updateAdrStatus(getActiveRoot(state).rootPath, ctx.input.path, ctx.input.status, ctx.input.expectedHash);
            },
        },
    ],
    open: async (ctx) => {
        if (ctx.input && Object.keys(ctx.input).length > 0) {
            throw new CanvasError("canvas_input_invalid", "This canvas uses the configured ADR folder in the active workspace.");
        }

        const prefs = await readPreferences();
        const roots = resolveAdrRoots(ctx.session, prefs.adrFolder);
        instances.set(ctx.instanceId, { roots, activeIndex: 0 });

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
