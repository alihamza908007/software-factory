import { promises as fs } from "node:fs";
import path from "node:path";
import { WORKSPACES_ROOT } from "./db";
import { slugify } from "./utils";

const BLOCKED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".factory",
  ".env",
]);

export function workspacePathFor(slug: string, id: string): string {
  return path.join(WORKSPACES_ROOT, `${slug}-${id.replace(/[^a-zA-Z0-9]/g, "").slice(-6)}`);
}

export function resolveInside(root: string, relative: string): string {
  const normalized = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment === ".." ||
        BLOCKED_SEGMENTS.has(segment) ||
        segment.startsWith(".env"),
    )
  ) {
    throw new Error(`Blocked path: ${relative}`);
  }
  const resolved = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${relative}`);
  }
  return resolved;
}

export async function writeProjectFile(
  root: string,
  relative: string,
  content: string,
): Promise<string> {
  const target = resolveInside(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return path.relative(root, target);
}

export async function readProjectFile(root: string, relative: string): Promise<string> {
  const target = resolveInside(root, relative);
  return fs.readFile(target, "utf8");
}

export async function pathExists(root: string, relative: string): Promise<boolean> {
  try {
    await fs.access(resolveInside(root, relative));
    return true;
  } catch {
    return false;
  }
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".data",
  ".factory",
  ".npm",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "dist",
  "build",
]);

const WORKSPACE_CACHE_TTL_MS = 2_000;
const workspaceCache = new Map<string, { files: string[]; at: number }>();

export function invalidateWorkspaceCache(root: string): void {
  for (const key of Array.from(workspaceCache.keys())) {
    if (key.startsWith(`${root}|`)) workspaceCache.delete(key);
  }
}

export async function listWorkspaceFiles(
  root: string,
  maxFiles = 300,
  subdir = "",
): Promise<string[]> {
  const key = `${root}|${subdir}|${maxFiles}`;
  const cached = workspaceCache.get(key);
  if (cached && Date.now() - cached.at < WORKSPACE_CACHE_TTL_MS) {
    return cached.files;
  }
  const out: string[] = [];
  async function walk(dir: string) {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith(".env")) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const rel = path.relative(root, path.join(dir, entry.name));
        out.push(rel);
      }
    }
  }
  await walk(path.join(root, subdir));
  workspaceCache.set(key, { files: out, at: Date.now() });
  return out;
}

export interface WorkspaceHandshakeFinding {
  code: "ROUTE_EXTENSION_CONFLICT" | "MISSING_PACKAGE_JSON" | "MISSING_PRISMA_SCHEMA" | "MISSING_ENV_EXAMPLE";
  severity: "error" | "warning";
  detail: string;
  resolutionPath: string;
  paths?: string[];
}

export interface WorkspaceHandshake {
  workspaceRoot: string;
  fileTree: string[];
  findings: WorkspaceHandshakeFinding[];
  blocked: boolean;
}

/** Inspect route and project configuration invariants before an agent handoff or build. */
export async function inspectWorkspaceHandshake(
  root: string,
  stack: "node" | "python" | "next",
): Promise<WorkspaceHandshake> {
  const fileTree = await listWorkspaceFiles(root, 500);
  const findings: WorkspaceHandshakeFinding[] = [];
  const extensions = new Set([".js", ".jsx", ".ts", ".tsx"]);
  const routes = new Map<string, string[]>();
  for (const file of fileTree) {
    const match = file.match(/^(?:(?:src\/)?app)\/(.*)\/(page|route)(\.[^/.]+)$/) ??
      file.match(/^(?:(?:src\/)?app)\/(page|route)(\.[^/.]+)$/);
    if (!match) continue;
    const hasNestedPath = match.length === 4;
    const routeDirectory = hasNestedPath ? match[1] : "";
    const entry = hasNestedPath ? match[2] : match[1];
    const extension = hasNestedPath ? match[3] : match[2];
    if (!extensions.has(extension.slice(1))) continue;
    const normalizedDirectory = routeDirectory.split("/").filter((part) => part && !/^\(.*\)$/.test(part)).join("/");
    const key = `${normalizedDirectory}/${entry}`;
    routes.set(key, [...(routes.get(key) ?? []), file]);
  }
  for (const [route, paths] of routes) {
    if (paths.length < 2) continue;
    findings.push({
      code: "ROUTE_EXTENSION_CONFLICT",
      severity: "error",
      detail: `Multiple files claim the same Next.js ${route} route: ${paths.join(", ")}`,
      resolutionPath: `Consolidate the route into one file and remove the duplicate route entry. Keep one page/route file for ${route}; then run npm run build.`,
      paths,
    });
  }

  const packageExists = await fs.access(path.join(root, "package.json")).then(() => true).catch(() => false);
  if (stack !== "python" && !packageExists) {
    findings.push({
      code: "MISSING_PACKAGE_JSON",
      severity: "error",
      detail: "This JavaScript/Next.js workspace has no package.json.",
      resolutionPath: "Create a package.json with the project's runtime scripts and declared dependencies, then run npm install and npm run build.",
      paths: ["package.json"],
    });
  }
  const packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = packageExists
    ? await fs.readFile(path.join(root, "package.json"), "utf8").then((value) => JSON.parse(value) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }).catch(() => ({}))
    : {};
  const hasPrisma = Boolean(packageJson.dependencies?.prisma || packageJson.devDependencies?.prisma || fileTree.some((file) => file.endsWith("prisma/schema.prisma")));
  const prismaExists = await fs.access(path.join(root, "prisma", "schema.prisma")).then(() => true).catch(() => false);
  if (hasPrisma && !prismaExists) {
    findings.push({
      code: "MISSING_PRISMA_SCHEMA",
      severity: "error",
      detail: "Prisma is configured or referenced, but prisma/schema.prisma is missing.",
      resolutionPath: "Create prisma/schema.prisma matching the data models used by the application, or remove the unused Prisma dependency and references; then run npx prisma validate.",
      paths: ["prisma/schema.prisma"],
    });
  }
  const envExampleExists = await fs.access(path.join(root, ".env.example")).then(() => true).catch(() => false);
  if (!envExampleExists) {
    findings.push({
      code: "MISSING_ENV_EXAMPLE",
      severity: "warning",
      detail: "No .env.example documents the workspace environment variables.",
      resolutionPath: "If the project reads environment variables, add a secret-free .env.example listing the required variable names.",
      paths: [".env.example"],
    });
  }
  return { workspaceRoot: path.resolve(root), fileTree, findings, blocked: findings.some((finding) => finding.severity === "error") };
}

/** Preserve the lower-priority duplicate route source, so Next can build while no source is lost. */
export async function preserveDuplicateRouteFiles(root: string, finding: WorkspaceHandshakeFinding): Promise<string[]> {
  if (finding.code !== "ROUTE_EXTENSION_CONFLICT" || !finding.paths || finding.paths.length < 2) return [];
  const rank: Record<string, number> = { ".tsx": 4, ".ts": 3, ".jsx": 2, ".js": 1 };
  const ordered = [...finding.paths].sort((left, right) => {
    const extRank = (file: string) => rank[path.extname(file)] ?? 0;
    return extRank(right) - extRank(left) || left.localeCompare(right);
  });
  const preserved: string[] = [];
  for (const relative of ordered.slice(1)) {
    const source = path.resolve(root, relative);
    if (!source.startsWith(`${path.resolve(root)}${path.sep}`)) continue;
    const backupRelative = path.join(".factory", "preflight-backups", `${relative}.${Date.now()}.conflict`).replace(/\\/g, "/");
    const backup = path.resolve(root, backupRelative);
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.rename(source, backup);
    preserved.push(`${relative} → ${backupRelative}`);
  }
  return preserved;
}

export async function readWorkspaceContext(
  root: string,
  maxChars = 40_000,
  extensions = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".json", ".md", ".yml", ".yaml"],
): Promise<string> {
  const files = await listWorkspaceFiles(root, 80);
  const parts: string[] = [];
  let used = 0;
  for (const file of files) {
    if (!extensions.some((ext) => file.endsWith(ext))) continue;
    if (file.includes("package-lock")) continue;
    try {
      const raw = await readProjectFile(root, file);
      const budget = Math.min(9000, maxChars - used);
      if (budget <= 200) break;
      const content = raw.length > budget ? `${raw.slice(0, budget)}\n/* … truncated … */` : raw;
      parts.push(`--- FILE: ${file} ---\n${content}`);
      used += content.length;
      if (used >= maxChars) break;
    } catch {
      // skip unreadable files
    }
  }
  return parts.join("\n\n");
}

export async function scaffoldProject(
  root: string,
  stack: "node" | "python" | "next",
  name: string,
): Promise<string[]> {
  await fs.mkdir(root, { recursive: true });
  const created: string[] = [];
  const write = async (rel: string, content: string) => {
    await writeProjectFile(root, rel, content);
    created.push(rel);
  };

  await write(
    ".gitignore",
    ["node_modules/", ".next/", "dist/", "build/", ".env", ".env.*", "__pycache__/", ".venv/", ".factory/", "*.log", ""].join("\n"),
  );

  if (stack === "python") {
    const pkg = slugify(name) || "factory-project";
    await write(
      "README.md",
      `# ${name}\n\nGenerated inside Software Factory.\n\n## Run\n\n\`\`\`bash\npython3 -m unittest discover -s tests -v\n\`\`\`\n`,
    );
    await write(
      "main.py",
      `"""${name} — scaffolded by Software Factory."""\n\n\ndef add(a: float, b: float) -> float:\n    return a + b\n\n\nif __name__ == "__main__":\n    print(add(1, 2))\n`,
    );
    await write("requirements.txt", "\n");
    await write(
      "tests/test_smoke.py",
      `import unittest\n\n\nclass SmokeTest(unittest.TestCase):\n    def test_toolchain_is_wired(self):\n        self.assertEqual(1 + 1, 2)\n\n\nif __name__ == "__main__":\n    unittest.main()\n`,
    );
    return created;
  }

  if (stack === "next") {
    const pkg = slugify(name) || "factory-project";
    await write(
      "package.json",
      JSON.stringify(
        {
          name: pkg,
          version: "0.1.0",
          private: true,
          scripts: {
            dev: "next dev",
            build: "next build",
            start: "next start",
            test: "node --test test/*.test.js",
          },
          dependencies: { next: "15.5.28", react: "19.2.9", "react-dom": "19.2.9" },
        },
        null,
        2,
      ) + "\n",
    );
    await write(
      "README.md",
      `# ${name}\n\nNext.js workspace generated by Software Factory.\n\nRun \`npm install && npm run dev\`.\n`,
    );
    await write(
      "app/page.jsx",
      `export default function Page() {\n  return <main><h1>${name}</h1><p>Factory workspace ready.</p></main>;\n}\n`,
    );
    await write(
      "app/layout.jsx",
      `export const metadata = { title: "${name}" };\n\nexport default function RootLayout({ children }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n`,
    );
    await write(
      "test/smoke.test.js",
      `import test from "node:test";\nimport assert from "node:assert/strict";\n\ntest("workspace is alive", () => {\n  assert.equal(1 + 1, 2);\n});\n`,
    );
    return created;
  }

  const pkg = slugify(name) || "factory-project";
  await write(
    "package.json",
    JSON.stringify(
      {
        name: pkg,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          start: "node src/index.js",
          test: "node --test test/*.test.js",
          check: "node --check src/index.js",
        },
      },
      null,
      2,
    ) + "\n",
  );
  await write(
    "README.md",
    `# ${name}\n\nGenerated inside Software Factory.\n\n## Verify\n\n\`\`\`bash\nnpm test\n\`\`\`\n`,
  );
  await write(
    "src/index.js",
    `/**\n * ${name}\n * Scaffolded by Software Factory. The implementation phase replaces this surface.\n */\nexport function add(a, b) {\n  return a + b;\n}\n\nexport function health() {\n  return { status: "ok", service: "${pkg}" };\n}\n\nif (import.meta.url === \`file://\${process.argv[1]}\`) {\n  console.log(health());\n}\n`,
  );
  await write(
    "test/smoke.test.js",
    `import test from "node:test";\nimport assert from "node:assert/strict";\n\n// Placeholder so the scaffold verifies the toolchain before real tests exist.\ntest("test toolchain is wired", () => {\n  assert.equal(1 + 1, 2);\n});\n`,
  );
  return created;
}

export async function cleanWorkspace(root: string) {
  try {
    await fs.rm(root, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export async function treeSummary(root: string, maxFiles = 200): Promise<string> {
  const files = await listWorkspaceFiles(root, maxFiles);
  return files.map((file) => `  ${file}`).join("\n");
}
