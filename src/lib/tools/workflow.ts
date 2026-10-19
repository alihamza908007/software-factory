import type { Project } from "../types";

export function buildWorkflow(project: Project): { path: string; content: string } {
  const path = ".github/workflows/main.yml";
  if (project.stack === "python") {
    return {
      path,
      content: `name: CI

on:
  push:
    branches: [main, "factory/**"]
  pull_request:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip

      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          if [ -s requirements.txt ]; then pip install -r requirements.txt; fi

      - name: Lint syntax
        run: python -m compileall -q .

      - name: Run tests
        run: |
          if [ -d tests ]; then python -m unittest discover -s tests -v; else echo "No tests directory"; fi
`,
    };
  }

  if (project.stack === "next") {
    return {
      path,
      content: `name: CI

on:
  push:
    branches: [main, "factory/**"]
  pull_request:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Test
        run: npm test --if-present

      - name: Build
        run: npm run build
`,
    };
  }

  return {
    path,
    content: `name: CI

on:
  push:
    branches: [main, "factory/**"]
  pull_request:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Syntax check
        run: |
          find src -name '*.js' -print0 2>/dev/null | xargs -0 -r -n1 node --check

      - name: Run tests
        run: npm test --if-present
`,
  };
}

export function verifyWorkflow(content: string): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!/^name:\s*\S+/m.test(content)) issues.push("Missing workflow name");
  if (!/^on:/m.test(content)) issues.push("Missing trigger block");
  if (!/^jobs:/m.test(content)) issues.push("Missing jobs block");
  if (!/actions\/checkout@/.test(content)) issues.push("No checkout step");
  if (!/runs-on:\s*\S+/.test(content)) issues.push("No runner");
  const tabs = content.split("\n").findIndex((line) => line.includes("\t"));
  if (tabs >= 0) issues.push("YAML contains tab indentation");
  return { valid: issues.length === 0, issues };
}
