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

let db: DatabaseSync | null = null;
let currentConfig: VectorMemoryConfig = { ...DEFAULT_CONFIG };

export function initVectorMemory(workspaceRoot: string): VectorMemoryConfig {
  const dbPath = path.join(workspaceRoot, ".factory", "vector-memory.db");
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  currentConfig = { ...DEFAULT_CONFIG, dbPath };
  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
      path UNINDEXED,
      content,
      tokenize='porter unicode61'
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_meta (
      path TEXT PRIMARY KEY,
      mtime INTEGER,
      size INTEGER
    );
  `);
  return currentConfig;
}

export function indexFile(filePath: string, content: string, mtime: number): void {
  if (!db) throw new Error("Vector memory not initialized. Call initVectorMemory first.");
  const existing = db.prepare("SELECT mtime FROM file_meta WHERE path = ?").get(filePath) as { mtime: number } | undefined;
  if (existing && existing.mtime === mtime) return; // unchanged
  db.prepare("DELETE FROM code_fts WHERE path = ?").run(filePath);
  const chunks = chunkContent(content, currentConfig.maxSnippetChars);
  const insert = db.prepare("INSERT INTO code_fts (path, content) VALUES (?, ?)");
  for (const chunk of chunks) insert.run(filePath, chunk);
  db.prepare("INSERT OR REPLACE INTO file_meta (path, mtime, size) VALUES (?, ?, ?)").run(filePath, mtime, content.length);
}

export function searchWorkspace(query: string, topK?: number): CodeSnippet[] {
  if (!db) throw new Error("Vector memory not initialized. Call initVectorMemory first.");
  const k = topK ?? currentConfig.topK;
  const stmt = db.prepare(
    `SELECT path, snippet(code_fts, 1, '', '', '…', 12) AS content, rank
     FROM code_fts WHERE code_fts MATCH ? ORDER BY rank LIMIT ?`,
  );
  const rows = stmt.all(query, k) as Array<{ path: string; content: string; rank: number }>;
  return rows.map((r) => ({
    path: r.path,
    content: (r.content ?? "").slice(0, currentConfig.maxSnippetChars),
    rank: r.rank,
  }));
}

export function removeFile(filePath: string): void {
  if (!db) return;
  db.prepare("DELETE FROM code_fts WHERE path = ?").run(filePath);
  db.prepare("DELETE FROM file_meta WHERE path = ?").run(filePath);
}

export function closeVectorMemory(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function getVectorMemoryStats(): { files: number; chunks: number } {
  if (!db) return { files: 0, chunks: 0 };
  const files = (db.prepare("SELECT COUNT(*) AS c FROM file_meta").get() as { c: number }).c;
  const chunks = (db.prepare("SELECT COUNT(*) AS c FROM code_fts").get() as { c: number }).c;
  return { files, chunks };
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