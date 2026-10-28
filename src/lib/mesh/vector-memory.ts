import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

/**
 * Semantic Context & SQLite FTS5 Vector Indexing.
 *
 * Replaces raw file dumps with a local SQLite-backed Full-Text Search (FTS5)
 * index over the workspace code. Agents issue semantic search queries and
 * receive only the top-N relevant snippets, keeping token usage under ~1k/turn.
 */

export interface CodeSnippet {
  path: string;
  content: string;
  rank: number;
}

export interface VectorMemoryConfig {
  dbPath: string;
  maxSnippetChars: number;
  topK: number;
}

const DEFAULT_CONFIG: VectorMemoryConfig = {
  dbPath: "",
  maxSnippetChars: 1_000,
  topK: 3,
};

const instances = new Map<string, DatabaseSync>();
let activeWorkspaceRoot: string = "";
let currentConfig: VectorMemoryConfig = { ...DEFAULT_CONFIG };

export function sanitizeFtsQuery(raw: string): string {
  // Strip FTS5 operators and punctuation that trigger syntax errors, preserving letters and numbers
  const cleaned = raw.replace(/[^\p{L}\p{N}_\s]/gu, " ").trim();
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (!tokens.length) return '""';
  // Use quoted prefix matches joined with OR
  return tokens.slice(0, 8).map((token) => `"${token}"*`).join(" OR ");
}

export function initVectorMemory(workspaceRoot: string): VectorMemoryConfig {
  const normalized = path.resolve(workspaceRoot);
  activeWorkspaceRoot = normalized;
  const dbPath = path.join(normalized, ".factory", "vector-memory.db");
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  currentConfig = { ...DEFAULT_CONFIG, dbPath };

  let dbInstance = instances.get(normalized);
  if (!dbInstance) {
    dbInstance = new DatabaseSync(dbPath);
    dbInstance.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
        path UNINDEXED,
        content,
        tokenize='porter unicode61'
      );
    `);
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS file_meta (
        path TEXT PRIMARY KEY,
        mtime INTEGER,
        size INTEGER
      );
    `);
    instances.set(normalized, dbInstance);
  }
  return currentConfig;
}

function getActiveDb(workspaceRoot?: string): DatabaseSync {
  const root = workspaceRoot ? path.resolve(workspaceRoot) : activeWorkspaceRoot;
  let target = instances.get(root);
  if (!target && root) {
    initVectorMemory(root);
    target = instances.get(root);
  }
  if (!target) throw new Error("Vector memory not initialized. Call initVectorMemory first.");
  return target;
}

export function indexFile(filePath: string, content: string, mtime: number, workspaceRoot?: string): void {
  const db = getActiveDb(workspaceRoot);
  const existing = db.prepare("SELECT mtime FROM file_meta WHERE path = ?").get(filePath) as { mtime: number } | undefined;
  if (existing && existing.mtime === mtime) return; // unchanged
  db.prepare("DELETE FROM code_fts WHERE path = ?").run(filePath);
  const chunks = chunkContent(content, currentConfig.maxSnippetChars);
  const insert = db.prepare("INSERT INTO code_fts (path, content) VALUES (?, ?)");
  for (const chunk of chunks) insert.run(filePath, chunk);
  db.prepare("INSERT OR REPLACE INTO file_meta (path, mtime, size) VALUES (?, ?, ?)").run(filePath, mtime, content.length);
}

export function searchWorkspace(query: string, topK?: number, workspaceRoot?: string): CodeSnippet[] {
  let db: DatabaseSync;
  try {
    db = getActiveDb(workspaceRoot);
  } catch {
    return [];
  }
  const k = topK ?? currentConfig.topK;
  const sanitized = sanitizeFtsQuery(query);

  try {
    const stmt = db.prepare(
      `SELECT path, snippet(code_fts, 1, '', '', '…', 12) AS content, rank
       FROM code_fts WHERE code_fts MATCH ? ORDER BY rank LIMIT ?`,
    );
    const rows = stmt.all(sanitized, k) as Array<{ path: string; content: string; rank: number }>;
    return rows.map((r) => ({
      path: r.path,
      content: (r.content ?? "").slice(0, currentConfig.maxSnippetChars),
      rank: r.rank,
    }));
  } catch (err) {
    // Fallback: If sanitized FTS query still fails, try plain word search
    try {
      const firstWord = query.replace(/[^\w]/g, " ").trim().split(/\s+/)[0];
      if (!firstWord) return [];
      const fallbackStmt = db.prepare(
        `SELECT path, snippet(code_fts, 1, '', '', '…', 12) AS content, rank
         FROM code_fts WHERE code_fts MATCH ? ORDER BY rank LIMIT ?`,
      );
      const rows = fallbackStmt.all(`"${firstWord}"*`, k) as Array<{ path: string; content: string; rank: number }>;
      return rows.map((r) => ({
        path: r.path,
        content: (r.content ?? "").slice(0, currentConfig.maxSnippetChars),
        rank: r.rank,
      }));
    } catch {
      return [];
    }
  }
}

export function removeFile(filePath: string, workspaceRoot?: string): void {
  try {
    const db = getActiveDb(workspaceRoot);
    db.prepare("DELETE FROM code_fts WHERE path = ?").run(filePath);
    db.prepare("DELETE FROM file_meta WHERE path = ?").run(filePath);
  } catch {}
}

export function closeVectorMemory(workspaceRoot?: string): void {
  if (workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    const instance = instances.get(root);
    if (instance) {
      instance.close();
      instances.delete(root);
    }
  } else {
    for (const [key, instance] of instances) {
      instance.close();
      instances.delete(key);
    }
    activeWorkspaceRoot = "";
  }
}

export function getVectorMemoryStats(workspaceRoot?: string): { files: number; chunks: number } {
  try {
    const db = getActiveDb(workspaceRoot);
    const files = (db.prepare("SELECT COUNT(*) AS c FROM file_meta").get() as { c: number }).c;
    const chunks = (db.prepare("SELECT COUNT(*) AS c FROM code_fts").get() as { c: number }).c;
    return { files, chunks };
  } catch {
    return { files: 0, chunks: 0 };
  }
}

function chunkContent(content: string, maxChars: number): string[] {
  if (content.length <= maxChars) return [content];
  const chunks: string[] = [];
  const lines = content.split("\n");
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > maxChars && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [content.slice(0, maxChars)];
}