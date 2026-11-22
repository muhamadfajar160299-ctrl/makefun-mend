import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

// mend: applies an AI-written edit to a tree of text files.
// Four patch formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits),
// three tiers of line matching, all-or-nothing writes.
//
// When the trial environment variable is present, control is handed to the
// runner module sitting beside this file instead of running patch mode.

type ApplyOk = { ok: true; move?: { old: string; nw: string } };
type ApplyFail = { ok: false; code: string; path: string };
type ApplyResult = ApplyOk | ApplyFail;

interface Edit {
  apply(tree: Map<string, string>, strict: boolean): ApplyResult;
}

class ParseFault extends Error {
  line: number;
  constructor(line: number) {
    super("parse " + line);
    this.line = line;
  }
}

function out(text: string): void {
  process.stdout.write(text);
}

function isBlank(s: string): boolean {
  return s.trim() === "";
}

function stripTrailingWs(s: string): string {
  return s.replace(/\s+$/, "");
}

// A patch's lines: split at \n, one trailing \r removed from each, and the
// empty piece after a final \n dropped.
function splitPatchLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n").map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// ---------------------------------------------------------------------------
// Files and lines
// ---------------------------------------------------------------------------

interface FileModel {
  lines: string[];
  eol: string;
  finalBreak: boolean;
}

function toModel(text: string): FileModel {
  if (text === "") return { lines: [], eol: "\n", finalBreak: false };
  const firstLf = text.indexOf("\n");
  const eol = firstLf > 0 && text[firstLf - 1] === "\r" ? "\r\n" : "\n";
  const parts = text.split(eol);
  let finalBreak = false;
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
    finalBreak = true;
  }
  return { lines: parts, eol, finalBreak };
}

function fromModel(m: FileModel): string {
  if (m.lines.length === 0) return "";
  return m.lines.join(m.eol) + (m.finalBreak ? m.eol : "");
}

function isSafePath(p: string): boolean {
  if (p === "") return false;
  if (p.startsWith("/")) return false;
  if (p.indexOf("\\") >= 0) return false;
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Line matching (three tiers)
// ---------------------------------------------------------------------------

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, "");
  return line.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : "";
}

function occurrencesAt(lines: string[], pat: string[], tier: number, from: number): number[] {
  const found: number[] = [];
  if (pat.length === 0) return found;
  const np = pat.map((l) => normLine(l, tier));
  const start = Math.max(0, from);
  for (let i = start; i + pat.length <= lines.length; i++) {
    let good = true;
    for (let j = 0; j < pat.length; j++) {
      if (normLine(lines[i + j], tier) !== np[j]) {
        good = false;
        break;
      }
    }
    if (good) found.push(i);
  }
  return found;
}

function findAtTier(
  lines: string[],
  pat: string[],
  from: number,
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrencesAt(lines, pat, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface OLine {
  text: string;
  context: boolean;
}

// Builds the lines that replace the matched block. Context lines are written
// as the file's own matched lines; at tier 2 every other new line is
// re-indented from the old block's first-line indent to the file's.
function buildReplacement(
  fileLines: string[],
  pos: number,
  oEntries: OLine[],
  nEntries: OLine[],
  tier: number,
): string[] {
  const ctxFile: string[] = [];
  for (let k = 0; k < oEntries.length; k++) {
    if (oEntries[k].context) ctxFile.push(fileLines[pos + k]);
  }
  let ctxIdx = 0;
  const outLines: string[] = [];
  const firstFile = pos < fileLines.length ? fileLines[pos] : "";
  const firstPat = oEntries.length > 0 ? oEntries[0].text : "";
  const f = leadingWs(firstFile);
  const p = leadingWs(firstPat);
  for (const e of nEntries) {
    if (e.context) {
      outLines.push(ctxFile[ctxIdx]);
      ctxIdx++;
      continue;
    }
    if (tier === 2) {
      const line = e.text;
      if (line.length > 0 && line.trim() !== "" && line.startsWith(p)) {
        outLines.push(f + line.slice(p.length));
      } else {
        outLines.push(line);
      }
    } else {
      outLines.push(e.text);
    }
  }
  return outLines;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

interface Cli {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): Cli | null {
  let format: string | null = null;
  let formatSeen = false;
  let check = false;
  let checkSeen = false;
  let strict = false;
  let strictSeen = false;
  const positionals: string[] = [];
  let endOpts = false;
  for (const arg of argv) {
    if (!endOpts && arg === "--") {
      endOpts = true;
      continue;
    }
    if (!endOpts && arg.startsWith("-") && arg !== "-") {
      if (arg === "--check") {
        if (checkSeen) return null;
        checkSeen = true;
        check = true;
      } else if (arg === "--strict") {
        if (strictSeen) return null;
        strictSeen = true;
        strict = true;
      } else if (arg.startsWith("--format=")) {
        if (formatSeen) return null;
        formatSeen = true;
        const v = arg.slice("--format=".length);
        if (v !== "unified" && v !== "search-replace" && v !== "v4a" && v !== "json" && v !== "auto") {
          return null;
        }
        format = v;
      } else {
        return null;
      }
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) return null;
  return { format: format === null ? "auto" : format, check, strict, patch: positionals.length === 0 ? null : positionals[0] };
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  let firstNonBlank: string | undefined;
  for (const l of lines) {
    if (!isBlank(l)) {
      firstNonBlank = l;
      break;
    }
  }
  if (firstNonBlank !== undefined && firstNonBlank.trim() === "*** Begin Patch") return "v4a";
  if (firstNonBlank !== undefined) {
    const m = /\S/.exec(firstNonBlank);
    if (m && (m[0] === "[" || m[0] === "{")) return "json";
  }
  for (const l of lines) {
    if (stripTrailingWs(l) === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) return "unified";
    if (lines[i].startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
      return "unified";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs
// ---------------------------------------------------------------------------

interface HunkLine {
  kind: "ctx" | "old" | "new" | "mark";
  text: string;
}

interface Hunk {
  a: number;
  body: HunkLine[];
}

interface UniSection {
  diffOld: string;
  diffNew: string;
  pairOld: string | null;
  pairNew: string | null;
  renOld: string | null;
  renNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function isDiffGitLine(s: string): boolean {
  return s === "diff --git" || s.startsWith("diff --git ");
}

function diffGitPaths(s: string): { x: string; y: string } | null {
  if (!isDiffGitLine(s)) return null;
  const rest = s.slice("diff --git".length).trim();
  const m = /^a\/(\S+) b\/(\S+)$/.exec(rest);
  if (!m) return null;
  return { x: m[1], y: m[2] };
}

// The path after `--- ` / `+++ `: text after the four characters, up to the
// first tab, surrounding spaces removed, one leading a/ or b/ removed.
function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf("\t");
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith("a/")) t = t.slice(2);
  else if (t.startsWith("b/")) t = t.slice(2);
  return t;
}

function parseHunkBody(lines: string[], start: number): { body: HunkLine[]; next: number } {
  const body: HunkLine[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) break;
    if (line === "") {
      body.push({ kind: "ctx", text: "" });
      i++;
      continue;
    }
    const c = line[0];
    if (c === " ") {
      body.push({ kind: "ctx", text: line.slice(1) });
      i++;
      continue;
    }
    if (c === "-") {
      body.push({ kind: "old", text: line.slice(1) });
      i++;
      continue;
    }
    if (c === "+") {
      body.push({ kind: "new", text: line.slice(1) });
      i++;
      continue;
    }
    if (c === "\\") {
      body.push({ kind: "mark", text: line });
      i++;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1];
    if (last.kind === "ctx" && last.text === "") body.pop();
    else break;
  }
  return { body, next: i };
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let headerPhase = false;
  let i = 0;
  const n = lines.length;
  const newSection = (diffOld: string, diffNew: string): UniSection => {
    const s: UniSection = {
      diffOld,
      diffNew,
      pairOld: null,
      pairNew: null,
      renOld: null,
      renNew: null,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    headerPhase = true;
    return s;
  };
  while (i < n) {
    const line = lines[i];
    if (isDiffGitLine(line)) {
      const paths = diffGitPaths(line);
      if (!paths) throw new ParseFault(i + 1);
      newSection(paths.x, paths.y);
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      if (cur === null) throw new ParseFault(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (!m) throw new ParseFault(i + 1);
      const hunk: Hunk = { a: parseInt(m[1], 10), body: [] };
      const parsed = parseHunkBody(lines, i + 1);
      hunk.body = parsed.body;
      cur.hunks.push(hunk);
      headerPhase = false;
      i = parsed.next;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (i + 1 < n && lines[i + 1].startsWith("+++ ")) {
        if (cur !== null && headerPhase && cur.pairOld === null) {
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(lines[i + 1]);
          i += 2;
          continue;
        }
        const s = newSection("", "");
        s.pairOld = headerPath(line);
        s.pairNew = headerPath(lines[i + 1]);
        i += 2;
        continue;
      }
      if (cur !== null && headerPhase) throw new ParseFault(i + 2);
      i++;
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (cur !== null && headerPhase) {
        cur.pairNew = headerPath(line);
      }
      i++;
      continue;
    }
    if (cur !== null && headerPhase) {
      if (line.startsWith("rename from ")) {
        cur.renOld = line.slice("rename from ".length).trim();
      } else if (line.startsWith("rename to ")) {
        cur.renNew = line.slice("rename to ".length).trim();
      } else if (line.startsWith("new file mode")) {
        cur.newFile = true;
      } else if (line.startsWith("deleted file mode")) {
        cur.deletedFile = true;
      }
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new ParseFault(1);
  return sections;
}

function resolveUniPaths(sec: UniSection): { old: string | null; nw: string | null } {
  const norm = (p: string | null): string | null => (p === "/dev/null" ? null : p);
  const oldRaw = sec.pairOld !== null ? sec.pairOld : sec.renOld !== null ? sec.renOld : sec.diffOld;
  const newRaw = sec.pairNew !== null ? sec.pairNew : sec.renNew !== null ? sec.renNew : sec.diffNew;
  return { old: norm(oldRaw === "" ? null : oldRaw), nw: norm(newRaw === "" ? null : newRaw) };
}

// Whether a `\` line follows the hunk's last context or `+` line.
function backslashAfterLastCtxOrPlus(h: Hunk): boolean {
  let lastIdx = -1;
  for (let k = 0; k < h.body.length; k++) {
    if (h.body[k].kind === "ctx" || h.body[k].kind === "new") lastIdx = k;
  }
  if (lastIdx < 0) return false;
  const next = h.body[lastIdx + 1];
  return next !== undefined && next.kind === "mark";
}

function splitHunk(h: Hunk): { o: OLine[]; n: OLine[] } {
  const o: OLine[] = [];
  const n: OLine[] = [];
  for (const bl of h.body) {
    if (bl.kind === "ctx") {
      o.push({ text: bl.text, context: true });
      n.push({ text: bl.text, context: true });
    } else if (bl.kind === "old") {
      o.push({ text: bl.text, context: false });
    } else if (bl.kind === "new") {
      n.push({ text: bl.text, context: false });
    }
  }
  return { o, n };
}

// Applies a section's hunks to a file's text. Returns null on no-match.
function applyHunksToText(text: string, hunks: Hunk[], strict: boolean): string | null {
  const model = toModel(text);
  const lines = model.lines.slice();
  let finalBreak = model.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitHunk(h);
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const atEnd = pos === lines.length;
      const newTexts = n.map((e) => e.text);
      lines.splice(pos, 0, ...newTexts);
      if (atEnd) finalBreak = !backslashAfterLastCtxOrPlus(h);
      d += newTexts.length;
      continue;
    }
    const found = findAtTier(lines, o.map((e) => e.text), 0, strict);
    if (!found) return null;
    const target = h.a - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const pos = best;
    const runsToEnd = pos + o.length === lines.length;
    const repl = buildReplacement(lines, pos, o, n, found.tier);
    lines.splice(pos, o.length, ...repl);
    if (runsToEnd) finalBreak = !backslashAfterLastCtxOrPlus(h);
    d += n.length - o.length;
  }
  return fromModel({ lines, eol: model.eol, finalBreak });
}

function creationFinalBreak(hunks: Hunk[]): boolean {
  let lastHunk: Hunk | null = null;
  let lastIdx = -1;
  for (const h of hunks) {
    for (let k = 0; k < h.body.length; k++) {
      if (h.body[k].kind === "new") {
        lastHunk = h;
        lastIdx = k;
      }
    }
  }
  if (lastHunk === null) return true;
  const next = lastHunk.body[lastIdx + 1];
  return !(next !== undefined && next.kind === "mark");
}

function applyUnifiedSection(sec: UniSection, tree: Map<string, string>, strict: boolean): ApplyResult {
  const { old, nw } = resolveUniPaths(sec);
  let kind: "create" | "delete" | "move" | "change";
  if (old === null || sec.newFile) kind = "create";
  else if (nw === null || sec.deletedFile) kind = "delete";
  else if (old !== nw) kind = "move";
  else kind = "change";
  const pathsToCheck: (string | null)[] =
    kind === "create" ? [nw] : kind === "delete" ? [old] : kind === "move" ? [old, nw] : [old];
  for (const p of pathsToCheck) {
    if (p === null || !isSafePath(p)) return { ok: false, code: "unsafe", path: p === null ? "" : p };
  }
  if (kind === "create") {
    const newPath = nw as string;
    if (tree.has(newPath)) return { ok: false, code: "exists", path: newPath };
    const plusLines: string[] = [];
    for (const h of sec.hunks) {
      for (const bl of h.body) {
        if (bl.kind === "new") plusLines.push(bl.text);
      }
    }
    const text =
      plusLines.length === 0 ? "" : plusLines.join("\n") + (creationFinalBreak(sec.hunks) ? "\n" : "");
    tree.set(newPath, text);
    return { ok: true };
  }
  if (kind === "delete") {
    const oldPath = old as string;
    if (!tree.has(oldPath)) return { ok: false, code: "missing", path: oldPath };
    tree.delete(oldPath);
    return { ok: true };
  }
  const oldPath = old as string;
  const newPath = nw as string;
  if (kind === "move") {
    if (!tree.has(oldPath)) return { ok: false, code: "missing", path: oldPath };
    if (tree.has(newPath)) return { ok: false, code: "exists", path: newPath };
    const result = applyHunksToText(tree.get(oldPath) as string, sec.hunks, strict);
    if (result === null) return { ok: false, code: "no-match", path: oldPath };
    tree.delete(oldPath);
    tree.set(newPath, result);
    return { ok: true, move: { old: oldPath, nw: newPath } };
  }
  if (!tree.has(oldPath)) return { ok: false, code: "missing", path: oldPath };
  const result = applyHunksToText(tree.get(oldPath) as string, sec.hunks, strict);
  if (result === null) return { ok: false, code: "no-match", path: oldPath };
  tree.set(oldPath, result);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (stripTrailingWs(lines[i]) === "<<<<<<< SEARCH") {
      const searchIdx = i;
      let p: string | null = null;
      for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
        const t = lines[j];
        if (isBlank(t)) continue;
        if (t.trim().startsWith("```")) continue;
        p = t.trim();
        break;
      }
      if (p === null) {
        if (prevPath !== null) p = prevPath;
        else throw new ParseFault(searchIdx + 1);
      }
      let sep = -1;
      for (let j = searchIdx + 1; j < lines.length; j++) {
        if (stripTrailingWs(lines[j]) === "=======") {
          sep = j;
          break;
        }
      }
      if (sep === -1) throw new ParseFault(searchIdx + 1);
      let rep = -1;
      for (let j = sep + 1; j < lines.length; j++) {
        if (stripTrailingWs(lines[j]) === ">>>>>>> REPLACE") {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new ParseFault(searchIdx + 1);
      blocks.push({
        path: p,
        oldLines: lines.slice(searchIdx + 1, sep),
        newLines: lines.slice(sep + 1, rep),
      });
      prevPath = p;
      prevReplaceEnd = rep;
      i = rep + 1;
      continue;
    }
    i++;
  }
  if (blocks.length === 0) throw new ParseFault(1);
  return blocks;
}

function applySRBlock(b: SRBlock, tree: Map<string, string>, strict: boolean): ApplyResult {
  if (!isSafePath(b.path)) return { ok: false, code: "unsafe", path: b.path };
  if (b.oldLines.length === 0) {
    if (tree.has(b.path)) return { ok: false, code: "exists", path: b.path };
    tree.set(b.path, b.newLines.length === 0 ? "" : b.newLines.join("\n") + "\n");
    return { ok: true };
  }
  const cur = tree.get(b.path);
  if (cur === undefined) return { ok: false, code: "missing", path: b.path };
  const model = toModel(cur);
  const found = findAtTier(model.lines, b.oldLines, 0, strict);
  if (!found) return { ok: false, code: "no-match", path: b.path };
  if (found.occ.length > 1) return { ok: false, code: "ambiguous", path: b.path };
  const pos = found.occ[0];
  const oEntries: OLine[] = b.oldLines.map((t) => ({ text: t, context: false }));
  const nEntries: OLine[] = b.newLines.map((t) => ({ text: t, context: false }));
  const repl = buildReplacement(model.lines, pos, oEntries, nEntries, found.tier);
  const lines = model.lines.slice();
  lines.splice(pos, oEntries.length, ...repl);
  tree.set(b.path, fromModel({ lines, eol: model.eol, finalBreak: model.finalBreak }));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// V4A patches
// ---------------------------------------------------------------------------

interface V4ABodyLine {
  kind: "ctx" | "old" | "new";
  text: string;
}

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: V4ABodyLine[];
}

interface V4ASection {
  kind: "add" | "delete" | "update";
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4AChunk[];
}

function parseV4A(lines: string[]): V4ASection[] {
  let first = -1;
  let last = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!isBlank(lines[k])) {
      if (first < 0) first = k;
      last = k;
    }
  }
  if (first < 0) throw new ParseFault(1);
  if (lines[first].trim() !== "*** Begin Patch") throw new ParseFault(first + 1);
  if (lines[last].trim() !== "*** End Patch") throw new ParseFault(lines.length + 1);
  const sections: V4ASection[] = [];
  let i = first + 1;
  const isSectionStart = (s: string): boolean =>
    s.startsWith("*** Add File: ") || s.startsWith("*** Delete File: ") || s.startsWith("*** Update File: ");
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    let kind: "add" | "delete" | "update";
    let p: string;
    if (line.startsWith("*** Add File: ")) {
      kind = "add";
      p = line.slice("*** Add File: ".length).trim();
    } else if (line.startsWith("*** Delete File: ")) {
      kind = "delete";
      p = line.slice("*** Delete File: ".length).trim();
    } else if (line.startsWith("*** Update File: ")) {
      kind = "update";
      p = line.slice("*** Update File: ".length).trim();
    } else {
      throw new ParseFault(i + 1);
    }
    const headerLineNo = i + 1;
    i++;
    const content: { text: string; no: number }[] = [];
    while (i < last) {
      if (isSectionStart(lines[i])) break;
      content.push({ text: lines[i], no: i + 1 });
      i++;
    }
    while (content.length > 0 && isBlank(content[content.length - 1].text)) content.pop();
    const sec: V4ASection = { kind, path: p, moveTo: null, addLines: [], chunks: [] };
    if (kind === "add") {
      for (const c of content) {
        if (c.text.startsWith("+")) sec.addLines.push(c.text.slice(1));
        else if (c.text === "") sec.addLines.push("");
        else throw new ParseFault(c.no);
      }
    } else if (kind === "delete") {
      if (content.length > 0) throw new ParseFault(content[0].no);
    } else {
      let idx = 0;
      if (content.length > 0 && content[0].text.startsWith("*** Move to: ")) {
        sec.moveTo = content[0].text.slice("*** Move to: ".length).trim();
        idx = 1;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      for (; idx < content.length; idx++) {
        const c = content[idx];
        const t = c.text;
        if (t.startsWith("@@")) {
          if (cur !== null) chunks.push(cur);
          const anchorText = t.slice(2).trim();
          cur = { anchor: anchorText === "" ? null : anchorText, eof: false, body: [] };
          continue;
        }
        if (t === "*** End of File") {
          if (cur === null) throw new ParseFault(c.no);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          continue;
        }
        if (t === "" || t[0] === " " || t[0] === "-" || t[0] === "+") {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, eof: false, body: [] };
            } else {
              throw new ParseFault(c.no);
            }
          }
          if (t === "") cur.body.push({ kind: "ctx", text: "" });
          else if (t[0] === " ") cur.body.push({ kind: "ctx", text: t.slice(1) });
          else if (t[0] === "-") cur.body.push({ kind: "old", text: t.slice(1) });
          else cur.body.push({ kind: "new", text: t.slice(1) });
          continue;
        }
        throw new ParseFault(c.no);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && sec.moveTo === null) throw new ParseFault(headerLineNo);
      sec.chunks = chunks;
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new ParseFault(1);
  return sections;
}

function applyV4ASection(sec: V4ASection, tree: Map<string, string>, strict: boolean): ApplyResult {
  if (!isSafePath(sec.path)) return { ok: false, code: "unsafe", path: sec.path };
  if (sec.kind === "add") {
    if (tree.has(sec.path)) return { ok: false, code: "exists", path: sec.path };
    tree.set(sec.path, sec.addLines.length === 0 ? "" : sec.addLines.join("\n") + "\n");
    return { ok: true };
  }
  if (sec.kind === "delete") {
    if (!tree.has(sec.path)) return { ok: false, code: "missing", path: sec.path };
    tree.delete(sec.path);
    return { ok: true };
  }
  if (sec.moveTo !== null && !isSafePath(sec.moveTo)) {
    return { ok: false, code: "unsafe", path: sec.moveTo };
  }
  const cur = tree.get(sec.path);
  if (cur === undefined) return { ok: false, code: "missing", path: sec.path };
  if (sec.moveTo !== null && tree.has(sec.moveTo)) {
    return { ok: false, code: "exists", path: sec.moveTo };
  }
  const model = toModel(cur);
  const lines = model.lines.slice();
  let cursor = 0;
  for (const ch of sec.chunks) {
    if (ch.anchor !== null) {
      const foundAnchor = findAtTier(lines, [ch.anchor], cursor, strict);
      if (!foundAnchor) return { ok: false, code: "no-match", path: sec.path };
      cursor = foundAnchor.occ[0] + 1;
    }
    const oEntries: OLine[] = [];
    const nEntries: OLine[] = [];
    for (const b of ch.body) {
      if (b.kind === "ctx") {
        oEntries.push({ text: b.text, context: true });
        nEntries.push({ text: b.text, context: true });
      } else if (b.kind === "old") {
        oEntries.push({ text: b.text, context: false });
      } else {
        nEntries.push({ text: b.text, context: false });
      }
    }
    if (oEntries.length === 0) {
      const pos = ch.eof ? lines.length : cursor;
      const newTexts = nEntries.map((e) => e.text);
      lines.splice(pos, 0, ...newTexts);
      cursor = pos + newTexts.length;
      continue;
    }
    const found = findAtTier(lines, oEntries.map((e) => e.text), cursor, strict);
    if (!found) return { ok: false, code: "no-match", path: sec.path };
    let pos = -1;
    for (const p of found.occ) {
      if (ch.eof && p + oEntries.length !== lines.length) continue;
      pos = p;
      break;
    }
    if (pos < 0) return { ok: false, code: "no-match", path: sec.path };
    const repl = buildReplacement(lines, pos, oEntries, nEntries, found.tier);
    lines.splice(pos, oEntries.length, ...repl);
    cursor = pos + repl.length;
  }
  const text = fromModel({ lines, eol: model.eol, finalBreak: model.finalBreak });
  if (sec.moveTo !== null) {
    tree.delete(sec.path);
    tree.set(sec.moveTo, text);
    return { ok: true, move: { old: sec.path, nw: sec.moveTo } };
  }
  tree.set(sec.path, text);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// JSON edits
// ---------------------------------------------------------------------------

type JsonEdit =
  | { command: "create"; path: string; fileText: string }
  | { command: "str_replace"; path: string; oldStr: string; newStr: string }
  | { command: "insert"; path: string; insertLine: number; newStr: string };

function toJsonEdit(v: unknown): JsonEdit | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== "string") return null;
  if (typeof o.command !== "string") return null;
  if (o.command === "create") {
    if (typeof o.file_text !== "string") return null;
    return { command: "create", path: o.path, fileText: o.file_text };
  }
  if (o.command === "str_replace") {
    if (typeof o.old_str !== "string" || o.old_str === "") return null;
    if (o.new_str === undefined) {
      return { command: "str_replace", path: o.path, oldStr: o.old_str, newStr: "" };
    }
    if (typeof o.new_str !== "string") return null;
    return { command: "str_replace", path: o.path, oldStr: o.old_str, newStr: o.new_str };
  }
  if (o.command === "insert") {
    if (typeof o.insert_line !== "number" || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== "string") return null;
    return { command: "insert", path: o.path, insertLine: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function parseJsonEdits(text: string, lines: string[]): JsonEdit[] {
  const m = /\S/.exec(text);
  if (m && m[0] === "[") {
    const arrayLine = text.slice(0, m.index).split("\n").length;
    let val: unknown;
    try {
      val = JSON.parse(text);
    } catch {
      throw new ParseFault(arrayLine);
    }
    if (!Array.isArray(val)) throw new ParseFault(arrayLine);
    if (val.length === 0) throw new ParseFault(1);
    const edits: JsonEdit[] = [];
    for (const el of val) {
      const e = toJsonEdit(el);
      if (!e) throw new ParseFault(arrayLine);
      edits.push(e);
    }
    return edits;
  }
  const edits: JsonEdit[] = [];
  for (let k = 0; k < lines.length; k++) {
    if (isBlank(lines[k])) continue;
    let val: unknown;
    try {
      val = JSON.parse(lines[k]);
    } catch {
      throw new ParseFault(k + 1);
    }
    const e = toJsonEdit(val);
    if (!e) throw new ParseFault(k + 1);
    edits.push(e);
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

function applyJsonEdit(e: JsonEdit, tree: Map<string, string>): ApplyResult {
  if (!isSafePath(e.path)) return { ok: false, code: "unsafe", path: e.path };
  if (e.command === "create") {
    if (tree.has(e.path)) return { ok: false, code: "exists", path: e.path };
    tree.set(e.path, e.fileText);
    return { ok: true };
  }
  if (e.command === "str_replace") {
    const cur = tree.get(e.path);
    if (cur === undefined) return { ok: false, code: "missing", path: e.path };
    const model = toModel(cur);
    const crlf = model.eol === "\r\n";
    const textN = crlf ? cur.replace(/\r\n/g, "\n") : cur;
    const oldN = crlf ? e.oldStr.replace(/\r\n/g, "\n") : e.oldStr;
    const newN = crlf ? e.newStr.replace(/\r\n/g, "\n") : e.newStr;
    let count = 0;
    let first = -1;
    let idx = 0;
    for (;;) {
      const p = textN.indexOf(oldN, idx);
      if (p < 0) break;
      if (first < 0) first = p;
      count++;
      idx = p + 1;
    }
    if (count === 0) return { ok: false, code: "no-match", path: e.path };
    if (count > 1) return { ok: false, code: "ambiguous", path: e.path };
    const replaced = textN.slice(0, first) + newN + textN.slice(first + oldN.length);
    tree.set(e.path, crlf ? replaced.replace(/\n/g, "\r\n") : replaced);
    return { ok: true };
  }
  const cur = tree.get(e.path);
  if (cur === undefined) return { ok: false, code: "missing", path: e.path };
  const model = toModel(cur);
  if (e.insertLine < 0 || e.insertLine > model.lines.length) {
    return { ok: false, code: "no-match", path: e.path };
  }
  const ins = splitPatchLines(e.newStr);
  const lines = model.lines.slice();
  lines.splice(e.insertLine, 0, ...ins);
  tree.set(e.path, fromModel({ lines, eol: model.eol, finalBreak: model.finalBreak }));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Tree snapshot, change listing, writing
// ---------------------------------------------------------------------------

function snapshotTree(root: string): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix === "" ? e.name : prefix + "/" + e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, rel);
      } else if (e.isFile()) {
        try {
          result.set(rel, readFileSync(full, "utf-8"));
        } catch {
          // unreadable file: leave it out of the working tree
        }
      }
    }
  };
  walk(root, "");
  return result;
}

function computeChanges(
  orig: Map<string, string>,
  tree: Map<string, string>,
  moves: { old: string; nw: string }[],
): string[] {
  const items: { key: string; line: string }[] = [];
  const suppressedA = new Set<string>();
  const suppressedD = new Set<string>();
  for (const mv of moves) {
    if (orig.has(mv.old) && !tree.has(mv.old) && !orig.has(mv.nw) && tree.has(mv.nw)) {
      items.push({ key: mv.nw, line: "R " + mv.old + " -> " + mv.nw });
      suppressedD.add(mv.old);
      suppressedA.add(mv.nw);
    }
  }
  const allPaths = new Set<string>([...orig.keys(), ...tree.keys()]);
  for (const p of allPaths) {
    const b = orig.get(p);
    const a = tree.get(p);
    if (b === undefined && a !== undefined) {
      if (!suppressedA.has(p)) items.push({ key: p, line: "A " + p });
    } else if (b !== undefined && a === undefined) {
      if (!suppressedD.has(p)) items.push({ key: p, line: "D " + p });
    } else if (b !== undefined && a !== undefined && b !== a) {
      items.push({ key: p, line: "M " + p });
    }
  }
  items.sort((x, y) => Buffer.compare(Buffer.from(x.key, "utf-8"), Buffer.from(y.key, "utf-8")));
  return items.map((it) => it.line);
}

function writeTree(orig: Map<string, string>, tree: Map<string, string>): void {
  const removed: string[] = [];
  for (const p of orig.keys()) {
    if (!tree.has(p)) removed.push(p);
  }
  for (const p of removed) {
    try {
      unlinkSync(p);
    } catch {
      // already gone or not removable; the write below decides the outcome
    }
  }
  for (const p of removed) {
    let dir = path.dirname(p);
    while (dir !== "." && dir !== "") {
      try {
        rmdirSync(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }
  for (const [p, text] of tree) {
    if (orig.get(p) === text) continue;
    const dir = path.dirname(p);
    if (dir !== ".") mkdirSync(dir, { recursive: true });
    writeFileSync(p, text, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const trialUrl = process.env.MAKEFUN_ENV_URL;
  if (trialUrl) {
    const runnerModule = await import("./runner.ts");
    const exported = Object.values(runnerModule) as unknown[];
    const fns = exported.filter((v): v is (u: string) => Promise<unknown> => typeof v === "function");
    const trialFn =
      fns.find((f) => /trial/i.test(f.name)) ?? (fns.length > 0 ? fns[0] : undefined);
    if (!trialFn) throw new Error("runner module exports no trial function");
    const result = await trialFn(trialUrl);
    process.exitCode = typeof result === "number" ? result : 0;
    return;
  }

  const cli = parseArgs(process.argv.slice(2));
  if (cli === null) {
    out("error: usage\n");
    process.exitCode = 2;
    return;
  }

  let patchText: string;
  if (cli.patch === null || cli.patch === "-") {
    patchText = readFileSync(0, "utf-8");
  } else {
    try {
      patchText = readFileSync(cli.patch, "utf-8");
    } catch {
      out("error: no-patch\n");
      process.exitCode = 2;
      return;
    }
  }

  const lines = splitPatchLines(patchText);
  let format = cli.format;
  if (format === "auto") {
    const detected = detectFormat(lines);
    if (detected === null) {
      out("error: format\n");
      process.exitCode = 2;
      return;
    }
    format = detected;
  }

  let edits: Edit[];
  try {
    if (format === "unified") {
      edits = parseUnified(lines).map((sec) => ({
        apply: (tree: Map<string, string>, strict: boolean) => applyUnifiedSection(sec, tree, strict),
      }));
    } else if (format === "search-replace") {
      edits = parseSearchReplace(lines).map((b) => ({
        apply: (tree: Map<string, string>, strict: boolean) => applySRBlock(b, tree, strict),
      }));
    } else if (format === "v4a") {
      edits = parseV4A(lines).map((sec) => ({
        apply: (tree: Map<string, string>, strict: boolean) => applyV4ASection(sec, tree, strict),
      }));
    } else {
      edits = parseJsonEdits(patchText, lines).map((e) => ({
        apply: (tree: Map<string, string>) => applyJsonEdit(e, tree),
      }));
    }
  } catch (err) {
    if (err instanceof ParseFault) {
      out("error: parse " + err.line + "\n");
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  const orig = snapshotTree(process.cwd());
  const tree = new Map(orig);
  const failures: { code: string; path: string }[] = [];
  const moves: { old: string; nw: string }[] = [];
  for (const e of edits) {
    const r = e.apply(tree, cli.strict);
    if (!r.ok) {
      failures.push({ code: r.code, path: r.path });
    } else if (r.move) {
      moves.push(r.move);
    }
  }

  if (failures.length > 0) {
    let s = "";
    for (const f of failures) s += "error: " + f.code + " " + f.path + "\n";
    s += "failed: " + failures.length + " of " + edits.length + " edits\n";
    out(s);
    process.exitCode = 1;
    return;
  }

  const changeLines = computeChanges(orig, tree, moves);
  if (!cli.check) writeTree(orig, tree);
  let s = "";
  for (const cl of changeLines) s += cl + "\n";
  s += "ok: " + changeLines.length + (changeLines.length === 1 ? " file\n" : " files\n");
  out(s);
  process.exitCode = 0;
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exitCode = 1;
});
