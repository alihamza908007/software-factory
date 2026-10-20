import type { Node } from "@xyflow/react";
import type { CanvasNodeData } from "@/lib/types";

export type FlowNodeData = CanvasNodeData & Record<string, unknown>;

export type AgentFlowNode = Node<FlowNodeData, "agent">;
export type ValidatorFlowNode = Node<FlowNodeData, "validator">;
export type RouterFlowNode = Node<FlowNodeData, "router">;
export type FactoryFlowNode = AgentFlowNode | ValidatorFlowNode | RouterFlowNode;
