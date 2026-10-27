"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Download,
  GitBranch,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useFactory } from "@/lib/store";
import { defaultCanvasTopology, validateCanvasTopology } from "@/lib/canvas/topology";
import type { CanvasNodeData, CanvasTopology } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { AgentNode } from "./AgentNode";
import { ValidatorNode } from "./ValidatorNode";
import { RouterNode } from "./RouterNode";
import type { FactoryFlowNode, FlowNodeData } from "./types";

const STORAGE_KEY = "factory:canvas-topology:v1";
const nodeTypes = {
  agent: AgentNode,
  validator: ValidatorNode,
  router: RouterNode,
} as unknown as NodeTypes;

function toFlowNodes(topology: CanvasTopology): FactoryFlowNode[] {
  return topology.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: node.position,
    data: { ...node.data },
  })) as FactoryFlowNode[];
}

function toFlowEdges(topology: CanvasTopology): Edge[] {
  return topology.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    animated: edge.animated ?? true,
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    style: { stroke: edge.label === "fail" ? "#f87171" : "#6fe7dd", strokeWidth: 1.4 },
    labelStyle: { fill: "#a9b4ad", fontSize: 9, fontFamily: "monospace" },
  }));
}

function toTopology(nodes: FactoryFlowNode[], edges: Edge[]): CanvasTopology {
  return {
    version: 1,
    updatedAt: Date.now(),
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type as CanvasNodeData["kind"],
      position: node.position,
      data: node.data as CanvasNodeData,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: typeof edge.label === "string" ? edge.label : undefined,
      animated: edge.animated,
    })),
  };
}

let nodeCounter = 0;
function nextId(prefix: string): string {
  nodeCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${nodeCounter}`;
}

export function PipelineCanvas() {
  const {
    agents,
    models,
    projects,
    canvasTopology,
    setCanvasTopology,
    setActivePipelineTopology,
    activePipelineTopology,
    canvasValidation,
    canvasLoading,
    fetchCanvas,
    saveCanvasTopology,
    deactivateCanvasTopology,
    canvasLogs,
    setCanvasLogs,
    appendCanvasLog,
  } = useFactory();
  const [nodes, setNodes, onNodesChange] = useNodesState<FactoryFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [validating, setValidating] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [lastValidation, setLastValidation] = useState<ReturnType<typeof validateCanvasTopology> | null>(null);
  const [projectId, setProjectId] = useState("");
  const [brief, setBrief] = useState("");
  const [applyArtifacts, setApplyArtifacts] = useState(true);
  const initialized = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void fetchCanvas();
  }, [fetchCanvas]);

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  useEffect(() => {
    if (initialized.current || canvasLoading) return;
    let topology = canvasTopology;
    if (!topology) {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) topology = JSON.parse(raw) as CanvasTopology;
      } catch {
        topology = null;
      }
    }
    if (!topology && agents.length) topology = defaultCanvasTopology(agents);
    if (!topology) return;
    initialized.current = true;
    setNodes(toFlowNodes(topology));
    setEdges(toFlowEdges(topology));
    setCanvasTopology(topology);
  }, [agents, canvasLoading, canvasTopology, setCanvasTopology, setEdges, setNodes]);

  useEffect(() => {
    if (!initialized.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const topology = toTopology(nodes, edges);
      setCanvasTopology(topology);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(topology));
      } catch {
        // storage full or blocked
      }
      void saveCanvasTopology(topology, false).then((ok) => {
        if (ok) setSavedAt(Date.now());
      });
    }, 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [nodes, edges, saveCanvasTopology, setCanvasTopology]);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const selectedEdgeSource = selectedEdge
    ? nodes.find((node) => node.id === selectedEdge.source)
    : null;

  const updateNodeData = useCallback(
    (id: string, patch: Partial<CanvasNodeData>) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === id
            ? { ...node, data: { ...node.data, ...patch } as FlowNodeData }
            : node,
        ),
      );
    },
    [setNodes],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const source = nodes.find((node) => node.id === connection.source);
      const label: string | undefined = source?.type === "router" ? "pass" : undefined;
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            id: `edge-${Date.now().toString(36)}`,
            label,
            animated: true,
            markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
            style: { stroke: label === "fail" ? "#f87171" : "#6fe7dd", strokeWidth: 1.4 },
          },
          current,
        ),
      );
    },
    [nodes, setEdges],
  );

  const addNode = useCallback(
    (type: CanvasNodeData["kind"], agentId?: string) => {
      const agent = agents.find((item) => item.id === agentId);
      const id = nextId(type);
      const index = nodes.length;
      const node: FactoryFlowNode = {
        id,
        type,
        position: { x: 80 + (index % 5) * 270, y: 80 + Math.floor(index / 5) * 190 },
        data: {
          label:
            type === "agent"
              ? agent?.name ?? "Agent"
              : type === "validator"
                ? "Validator gate"
                : "Quality router",
          kind: type,
          agentId,
          modelKey: agent?.modelKey,
          provider: models.find((model) => model.key === agent?.modelKey)?.provider,
          prompt:
            type === "agent"
              ? "Advance the workflow using the upstream payload."
              : undefined,
          assertion: type === "validator" ? "score>=70" : undefined,
          condition: type === "router" ? "score>=70" : undefined,
          status: "idle",
        },
      } as FactoryFlowNode;
      setNodes((current) => [...current, node]);
      setSelectedNodeId(id);
      setSelectedEdgeId(null);
    },
    [agents, models, nodes.length, setNodes],
  );

  const removeSelected = useCallback(() => {
    if (!selectedNodeId && !selectedEdgeId) return;
    if (selectedNodeId) {
      setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
      setEdges((current) =>
        current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId),
      );
      setSelectedNodeId(null);
    }
    if (selectedEdgeId) {
      setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
      setSelectedEdgeId(null);
    }
  }, [selectedNodeId, selectedEdgeId, setNodes, setEdges]);

  const resetCanvas = useCallback(() => {
    const topology = defaultCanvasTopology(agents);
    setNodes(toFlowNodes(topology));
    setEdges(toFlowEdges(topology));
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setCanvasTopology(topology);
    toast.success("Canvas reset to the default SDLC topology.");
  }, [agents, setNodes, setEdges, setCanvasTopology]);

  async function validateCanvas() {
    setValidating(true);
    try {
      const topology = toTopology(nodes, edges);
      const local = validateCanvasTopology(topology);
      const res = await fetch("/api/canvas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "validate", topology }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Validation failed.");
      const validation = data.validation as ReturnType<typeof validateCanvasTopology>;
      setLastValidation(validation);
      if (validation.ok) {
        toast.success("Canvas topology is valid", {
          description: `${validation.nodeCount} nodes · ${validation.edgeCount} edges${
            validation.warnings.length ? ` · ${validation.warnings.length} warning(s)` : ""
          }`,
        });
      } else {
        toast.error("Canvas validation failed", { description: validation.errors.join(" ") });
      }
      if (validation.warnings.length) {
        appendCanvasLog(`[validate] ${validation.warnings.join(" | ")}`);
      }
      if (!local.ok && validation.ok) {
        appendCanvasLog(`[validate] local check: ${local.errors.join(" | ")}`);
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setValidating(false);
    }
  }

  async function runCanvas() {
    if (busy) return;
    const topology = toTopology(nodes, edges);
    const validation = validateCanvasTopology(topology, agents);
    setLastValidation(validation);
    if (!validation.ok) {
      toast.error("Fix the canvas before running", { description: validation.errors.join(" ") });
      return;
    }
    if (applyArtifacts && !projectId) {
      toast.error("Choose a project before applying artifacts.");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setCanvasLogs([]);
    appendCanvasLog(`[canvas] Parallel execution started · ${topology.nodes.length} nodes.`);
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        data: { ...node.data, status: "queued", detail: undefined } as FlowNodeData,
      })),
    );
    try {
      const res = await fetch("/api/canvas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "run",
          topology,
          projectId: projectId || undefined,
          initialInput: brief.trim() || undefined,
          applyArtifacts,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({ error: "Canvas execution failed." }));
        throw new Error(body.error ?? "Canvas execution failed.");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let eventName = "message";
          const dataLines: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length) {
            try {
              const payload = JSON.parse(dataLines.join("\n"));
              if (eventName === "canvas") {
                if (payload.nodeId) {
                  setNodes((current) =>
                    current.map((node) =>
                      node.id === payload.nodeId
                        ? {
                            ...node,
                            data: {
                              ...node.data,
                              status: payload.status ?? node.data.status,
                              detail: payload.detail ?? node.data.detail,
                              guardrailScore: payload.score ?? node.data.guardrailScore,
                              durationMs: payload.durationMs ?? node.data.durationMs,
                              tokens: payload.tokens ?? node.data.tokens,
                              error: payload.error ?? node.data.error,
                              outputPreview: payload.outputPreview ?? node.data.outputPreview,
                            } as FlowNodeData,
                          }
                        : node,
                    ),
                  );
                }
                if (payload.detail) appendCanvasLog(`[${payload.type}] ${payload.detail}`);
              } else if (eventName === "error") {
                toast.error(payload.message ?? "Canvas execution failed.");
                appendCanvasLog(`[error] ${payload.message ?? "unknown error"}`);
              } else if (eventName === "done") {
                const ok = payload.result?.ok;
                toast[ok ? "success" : "warning"](ok ? "Canvas execution complete" : "Canvas finished with failures", {
                  description: ok
                    ? `All nodes passed in ${Math.round((payload.result?.durationMs ?? 0) / 1000)}s.`
                    : "Inspect the failed node badges and logs.",
                });
              }
            } catch {
              // incomplete frame
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        toast.error(String(error));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function stopCanvas() {
    abortRef.current?.abort();
    setBusy(false);
  }

  function exportTopology() {
    const topology = toTopology(nodes, edges);
    const blob = new Blob([JSON.stringify(topology, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `factory-canvas-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("Canvas DAG exported.");
  }

  async function saveTopology() {
    const topology = toTopology(nodes, edges);
    setCanvasTopology(topology);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(topology));
    } catch {
      // storage full or blocked; the server copy is authoritative
    }
    const ok = await saveCanvasTopology(topology, false);
    if (!ok) {
      toast.error("Canvas could not be saved to the server.");
      return;
    }
    setSavedAt(Date.now());
    appendCanvasLog("[canvas] Topology saved to the factory database.");
    toast.success("Canvas topology saved.", {
      description: "The server copy is now the durable DAG for this factory.",
    });
  }

  async function exportToActivePipeline() {
    const topology = toTopology(nodes, edges);
    const validation = validateCanvasTopology(topology, agents);
    setLastValidation(validation);
    if (!validation.ok) {
      toast.error("Canvas cannot be activated", { description: validation.errors.join(" ") });
      return;
    }
    setCanvasTopology(topology);
    setActivePipelineTopology(topology);
    const ok = await saveCanvasTopology(topology, true);
    if (!ok) {
      toast.error("Canvas could not be activated on the server.");
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(topology));
    } catch {
      // best effort cache
    }
    appendCanvasLog("[canvas] Topology saved and activated as the SDLC blueprint.");
    toast.success("Topology is now the active SDLC blueprint", {
      description: `${topology.nodes.length} nodes · ${topology.edges.length} connections`,
    });
  }

  async function clearActive() {
    const ok = await deactivateCanvasTopology();
    if (!ok) {
      toast.error("Could not deactivate the active DAG.");
      return;
    }
    appendCanvasLog("[canvas] Active SDLC blueprint cleared; default phases will run.");
    toast.success("Active DAG cleared");
  }

  const nodeLabel = selectedNode?.data.label ?? "Inspector";
  const agentModels = useMemo(
    () => models.slice().sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name)),
    [models],
  );

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_280px]">
      <div className="panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
          <span className="mr-1 font-mono text-[9px] uppercase tracking-[0.16em] text-factory-cyan">
            Canvas DAG
          </span>
          <Button variant="outline" size="sm" onClick={() => addNode("agent")} disabled={busy}>
            <Plus className="h-3 w-3" /> Agent
          </Button>
          <Button variant="outline" size="sm" onClick={() => addNode("validator")} disabled={busy}>
            <ShieldCheck className="h-3 w-3" /> Validator
          </Button>
          <Button variant="outline" size="sm" onClick={() => addNode("router")} disabled={busy}>
            <GitBranch className="h-3 w-3" /> Router
          </Button>
          <span className="mx-1 h-4 w-px bg-border" />
          <Button variant="outline" size="sm" onClick={() => void validateCanvas()} disabled={validating || busy}>
            {validating ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
            Validate
          </Button>
          <Button size="sm" onClick={() => void runCanvas()} disabled={busy}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Run DAG
          </Button>
          {busy && (
            <Button variant="destructive" size="sm" onClick={stopCanvas}>
              <Square className="h-3 w-3" /> Stop
            </Button>
          )}
          <span className="mx-1 h-4 w-px bg-border" />
          <Button variant="ghost" size="sm" onClick={saveTopology} disabled={busy}>
            <Save className="h-3 w-3" /> Save
          </Button>
          <Button variant={activePipelineTopology?.updatedAt === canvasTopology?.updatedAt ? "secondary" : "outline"} size="sm" onClick={() => void exportToActivePipeline()} disabled={busy}>
            <GitBranch className="h-3 w-3" />
            {activePipelineTopology?.updatedAt === canvasTopology?.updatedAt ? "Active SDLC" : "Export to Active SDLC Pipeline"}
          </Button>
          {activePipelineTopology && (
            <Button variant="ghost" size="sm" onClick={() => void clearActive()} disabled={busy}>
              <RotateCcw className="h-3 w-3" /> Deactivate
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={exportTopology}>
            <Download className="h-3 w-3" /> Export
          </Button>
          <Button variant="ghost" size="sm" onClick={resetCanvas} disabled={busy}>
            <RotateCcw className="h-3 w-3" /> Reset
          </Button>
          <div className="ml-auto flex items-center gap-1.5">
            {selectedEdge && selectedEdgeSource?.type === "router" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const next = selectedEdge.label === "fail" ? "pass" : "fail";
                  setEdges((current) =>
                    current.map((edge) =>
                      edge.id === selectedEdge.id
                        ? {
                            ...edge,
                            label: next,
                            style: { ...edge.style, stroke: next === "fail" ? "#f87171" : "#6fe7dd" },
                          }
                        : edge,
                    ),
                  );
                }}
              >
                Branch: {String(selectedEdge.label ?? "pass")}
              </Button>
            )}
            {(selectedNodeId || selectedEdgeId) && (
              <Button variant="ghost" size="sm" onClick={removeSelected} disabled={busy}>
                <Trash2 className="h-3 w-3" /> Delete
              </Button>
            )}
            <Badge variant="outline">{nodes.length} nodes</Badge>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-secondary/50 px-2.5 py-2">
          <span className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">Run context</span>
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="h-7 w-[170px] text-[10px]">
              <SelectValue placeholder="No project workspace" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="Build brief for the first node (optional)"
            className="h-7 min-w-[220px] flex-1 text-[10px]"
          />
          <label className="flex items-center gap-1.5 font-mono text-[8px] text-muted-foreground">
            write generated files
            <Switch
              checked={applyArtifacts}
              onCheckedChange={setApplyArtifacts}
              className="h-4 w-7 [&>span]:h-3 [&>span]:w-3"
            />
          </label>
        </div>

        <div className="h-[620px] w-full">
          <ReactFlow<FactoryFlowNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => {
              setSelectedNodeId(node.id);
              setSelectedEdgeId(null);
            }}
            onEdgeClick={(_, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
            fitView
            proOptions={{ hideAttribution: true }}
            className="bg-background"
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#223027" />
            <Controls className="!border-border !bg-card" />
            <MiniMap
              pannable
              zoomable
              className="!border !border-border !bg-card"
              nodeColor={(node) => {
                if (node.type === "validator") return "#6fe7dd";
                if (node.type === "router") return "#f5b544";
                return "#c8f169";
              }}
            />
          </ReactFlow>
        </div>
        <div className="flex items-center justify-between border-t border-border/60 px-3 py-2 font-mono text-[9px] text-muted-foreground">
          <span>
            {savedAt ? `autosaved ${new Date(savedAt).toLocaleTimeString()}` : "unsaved"} · drag handles to connect · click a router edge to toggle pass/fail
          </span>
          <span>{canvasLogs.length} log lines</span>
        </div>
      </div>

      <aside className="space-y-3">
        <section className="panel p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Inspector</span>
            {selectedNode && <Badge variant="outline">{selectedNode.type}</Badge>}
          </div>
          {selectedNode ? (
            <div className="space-y-3">
              <div>
                <Label>Label</Label>
                <Input
                  value={selectedNode.data.label}
                  onChange={(event) => updateNodeData(selectedNode.id, { label: event.target.value })}
                  className="mt-1"
                />
              </div>
              {selectedNode.type === "agent" && (
                <>
                  <div>
                    <Label>Agent</Label>
                    <Select
                      value={selectedNode.data.agentId ?? ""}
                      onValueChange={(value) => {
                        const agent = agents.find((item) => item.id === value);
                        updateNodeData(selectedNode.id, {
                          agentId: value,
                          label: agent?.name ?? selectedNode.data.label,
                          modelKey: agent?.modelKey,
                          provider: models.find((model) => model.key === agent?.modelKey)?.provider,
                        });
                      }}
                    >
                      <SelectTrigger className="mt-1 font-mono text-[11px]">
                        <SelectValue placeholder="Assign an agent" />
                      </SelectTrigger>
                      <SelectContent>
                        {agents.map((agent) => (
                          <SelectItem key={agent.id} value={agent.id}>
                            {agent.name} · {agent.role}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Model override</Label>
                    <Select
                      value={selectedNode.data.modelKey ?? ""}
                      onValueChange={(value) => {
                        const model = agentModels.find((item) => item.key === value);
                        updateNodeData(selectedNode.id, { modelKey: value, provider: model?.provider });
                      }}
                    >
                      <SelectTrigger className="mt-1 font-mono text-[11px]">
                        <SelectValue placeholder="Use agent default" />
                      </SelectTrigger>
                      <SelectContent>
                        {agentModels.map((model) => (
                          <SelectItem key={model.key} value={model.key}>
                            {model.name} · {model.provider}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Instruction</Label>
                    <Textarea
                      value={selectedNode.data.prompt ?? ""}
                      onChange={(event) => updateNodeData(selectedNode.id, { prompt: event.target.value })}
                      className="mt-1 min-h-[110px] font-mono text-[10px]"
                    />
                  </div>
                </>
              )}
              {selectedNode.type === "validator" && (
                <div>
                  <Label>Assertion rule</Label>
                  <Textarea
                    value={selectedNode.data.assertion ?? ""}
                    onChange={(event) =>
                      updateNodeData(selectedNode.id, { assertion: event.target.value })
                    }
                    className="mt-1 min-h-[90px] font-mono text-[10px]"
                    placeholder="score>=70 or contains: acceptance criteria"
                  />
                  <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
                    Supports <span className="font-mono">contains:</span>,{" "}
                    <span className="font-mono">regex:</span>,{" "}
                    <span className="font-mono">length&gt;=N</span> and{" "}
                    <span className="font-mono">score&gt;=N</span>.
                  </p>
                </div>
              )}
              {selectedNode.type === "router" && (
                <div>
                  <Label>Condition</Label>
                  <Textarea
                    value={selectedNode.data.condition ?? ""}
                    onChange={(event) =>
                      updateNodeData(selectedNode.id, { condition: event.target.value })
                    }
                    className="mt-1 min-h-[90px] font-mono text-[10px]"
                    placeholder="score>=70"
                  />
                  <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
                    Edges labelled <span className="text-factory-lime">pass</span> or{" "}
                    <span className="text-factory-red">fail</span> only continue when the router
                    returns that branch.
                  </p>
                </div>
              )}
              {(selectedNode.data.durationMs ||
                selectedNode.data.tokens ||
                selectedNode.data.error ||
                selectedNode.data.outputPreview) && (
                <div className="rounded-md border border-border/60 bg-secondary/50 p-2">
                  <div className="flex flex-wrap items-center gap-2 font-mono text-[8px] text-muted-foreground">
                    <span>status {selectedNode.data.status ?? "idle"}</span>
                    {selectedNode.data.durationMs ? (
                      <span>{Math.round(selectedNode.data.durationMs)} ms</span>
                    ) : null}
                    {selectedNode.data.tokens ? <span>{selectedNode.data.tokens} tokens</span> : null}
                    {typeof selectedNode.data.guardrailScore === "number" && (
                      <span className="text-factory-lime">{selectedNode.data.guardrailScore}/100</span>
                    )}
                  </div>
                  {selectedNode.data.error && (
                    <p className="mt-1 break-words font-mono text-[9px] leading-relaxed text-red-300">
                      {selectedNode.data.error}
                    </p>
                  )}
                  {!selectedNode.data.error && selectedNode.data.outputPreview && (
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-secondary/50 p-2 font-mono text-[9px] leading-relaxed text-muted-foreground">
                      {selectedNode.data.outputPreview}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border/70 px-3 py-6 text-center text-[10px] text-muted-foreground">
              Select a node to configure it. Drag from the right handle into another node to create
              a payload edge.
            </div>
          )}
        </section>

        <section className="panel p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Topology checks</span>
            <Badge variant={lastValidation?.ok ?? canvasValidation?.ok ? "success" : "warning"}>
              {(lastValidation ?? canvasValidation)?.errors.length ?? 0} errors
            </Badge>
          </div>
          <div className="space-y-1 text-[9px] leading-relaxed">
            {(lastValidation ?? canvasValidation)?.errors.map((error) => (
              <p key={error} className="rounded border border-red-400/20 bg-red-400/5 px-2 py-1 text-red-300">
                {error}
              </p>
            ))}
            {(lastValidation ?? canvasValidation)?.warnings.slice(0, 6).map((warning) => (
              <p key={warning} className="rounded border border-factory-amber/20 bg-factory-amber/5 px-2 py-1 text-factory-amber/90">
                {warning}
              </p>
            ))}
            {!lastValidation && !canvasValidation && (
              <p className="px-1 py-4 text-center text-muted-foreground">
                Validate the DAG to inspect router branches, missing agents and duplicate edges.
              </p>
            )}
            {!!(lastValidation ?? canvasValidation)?.ok &&
              !(lastValidation ?? canvasValidation)?.warnings.length && (
                <p className="px-1 py-2 text-factory-lime">No topology issues detected.</p>
              )}
          </div>
        </section>

        <section className="panel p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Agent palette</span>
            <Badge variant="outline">{agents.length}</Badge>
          </div>
          <div className="space-y-1.5">
            {agents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => addNode("agent", agent.id)}
                disabled={busy}
                className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-secondary/50 px-2 py-1.5 text-left transition-colors hover:border-factory-lime/30 hover:bg-factory-lime/5 disabled:opacity-50"
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: agent.color }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px]">{agent.name}</span>
                  <span className="block truncate font-mono text-[8px] text-muted-foreground">
                    {agent.role}
                  </span>
                </span>
                <Plus className="h-3 w-3 text-muted-foreground" />
              </button>
            ))}
          </div>
        </section>

        <section className="panel p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Canvas log</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCanvasLogs([])}
              className="h-6 px-1.5 font-mono text-[8px]"
            >
              clear
            </Button>
          </div>
          <div className="max-h-[180px] overflow-y-auto rounded border border-border/50 bg-secondary/50 p-2 font-mono text-[9px] leading-relaxed text-muted-foreground">
            {canvasLogs.slice(-60).map((line, index) => (
              <div key={`${index}-${line.slice(0, 12)}`} className={cn(line.includes("[error]") && "text-red-300")}>
                {line}
              </div>
            ))}
            {!canvasLogs.length && <div>No execution events yet.</div>}
          </div>
        </section>
      </aside>
    </div>
  );
}
