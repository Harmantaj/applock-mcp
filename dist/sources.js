import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { antigravityRoots, claudeProjectsDir } from "./paths.js";
const UUIDISH = /^[0-9a-zA-Z_-]{8,}$/;
function safeStat(p) {
    try {
        return statSync(p);
    }
    catch {
        return undefined;
    }
}
function sizeOf(p) {
    const st = safeStat(p);
    if (!st)
        return 0;
    if (!st.isDirectory())
        return st.size;
    return readdirSync(p).reduce((n, name) => n + sizeOf(join(p, name)), 0);
}
function clip(s, n = 80) {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > n ? one.slice(0, n - 1) + "…" : one;
}
function textOf(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        for (const part of content) {
            if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
                return part.text;
            }
        }
    }
    return undefined;
}
/** Title precedence: user-set title, then AI title, then first human message. */
export function claudeTitle(jsonl) {
    let custom;
    let ai;
    let firstUser;
    for (const line of jsonl.split("\n")) {
        if (!line)
            continue;
        if (!line.includes('"custom-title"') && !line.includes('"ai-title"') && (firstUser || !line.includes('"type":"user"')))
            continue;
        let rec;
        try {
            rec = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (rec.type === "custom-title" && rec.customTitle)
            custom = rec.customTitle;
        else if (rec.type === "ai-title" && rec.aiTitle)
            ai = rec.aiTitle;
        else if (rec.type === "user" && !firstUser && !rec.isMeta) {
            const t = textOf(rec.message?.content);
            if (t && !t.startsWith("<"))
                firstUser = t;
        }
    }
    return clip(custom ?? ai ?? firstUser ?? "Untitled session");
}
export function projectLabel(dirName) {
    // Claude Code encodes the cwd by replacing "/" with "-".
    return dirName.replace(/^-/, "/").replace(/-/g, "/");
}
export function listClaudeSessions() {
    const root = claudeProjectsDir();
    if (!existsSync(root))
        return [];
    const current = process.env.CLAUDE_CODE_SESSION_ID;
    const out = [];
    for (const proj of readdirSync(root)) {
        const projDir = join(root, proj);
        if (!safeStat(projDir)?.isDirectory())
            continue;
        for (const file of readdirSync(projDir)) {
            if (!file.endsWith(".jsonl"))
                continue;
            const id = basename(file, ".jsonl");
            const path = join(projDir, file);
            const st = safeStat(path);
            if (!st)
                continue;
            const paths = [path];
            const sideDir = join(projDir, id);
            if (safeStat(sideDir)?.isDirectory())
                paths.push(sideDir);
            let title = "Untitled session";
            try {
                title = claudeTitle(readFileSync(path, "utf8"));
            }
            catch { }
            out.push({
                source: "claude-code",
                id,
                title,
                project: projectLabel(proj),
                updatedAt: st.mtime.toISOString(),
                sizeBytes: paths.reduce((n, p) => n + sizeOf(p), 0),
                paths,
                current: id === current || undefined,
            });
        }
    }
    return out;
}
/** Antigravity keeps protobuf transcripts; the title comes from the brain/ markdown if present. */
function antigravityTitle(root, id) {
    const brain = join(root, "brain", id);
    if (safeStat(brain)?.isDirectory()) {
        const md = readdirSync(brain).filter((f) => f.endsWith(".md")).sort();
        for (const f of md) {
            try {
                const heading = readFileSync(join(brain, f), "utf8").match(/^#\s+(.+)$/m);
                if (heading)
                    return clip(heading[1]);
            }
            catch { }
        }
    }
    const ann = join(root, "annotations", `${id}.pbtxt`);
    if (existsSync(ann)) {
        const m = readFileSync(ann, "utf8").match(/title:\s*"([^"]+)"/);
        if (m)
            return clip(m[1]);
    }
    return `Conversation ${id.slice(0, 8)}`;
}
export function listAntigravitySessions() {
    const out = [];
    for (const root of antigravityRoots()) {
        const convDir = join(root, "conversations");
        if (!safeStat(convDir)?.isDirectory())
            continue;
        for (const file of readdirSync(convDir)) {
            const m = file.match(/^(.+)\.pb$/);
            if (!m || !UUIDISH.test(m[1]))
                continue;
            const id = m[1];
            const paths = [join(convDir, file)];
            for (const extra of [join(root, "annotations", `${id}.pbtxt`), join(root, "brain", id), join(root, "implicit", id)]) {
                if (existsSync(extra))
                    paths.push(extra);
            }
            const st = safeStat(paths[0]);
            out.push({
                source: "antigravity",
                id,
                title: antigravityTitle(root, id),
                project: root,
                updatedAt: st.mtime.toISOString(),
                sizeBytes: paths.reduce((n, p) => n + sizeOf(p), 0),
                paths,
            });
        }
    }
    return out;
}
export function listSessions(source) {
    const all = [
        ...(source === "antigravity" ? [] : listClaudeSessions()),
        ...(source === "claude-code" ? [] : listAntigravitySessions()),
    ];
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function findSession(id) {
    const all = listSessions("all");
    return all.find((s) => s.id === id) ?? all.find((s) => s.id.startsWith(id) && id.length >= 6);
}
