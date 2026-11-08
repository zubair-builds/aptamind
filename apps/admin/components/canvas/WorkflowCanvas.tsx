'use client';

import { useCallback, useState } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Edge,
  type Node,
  type NodeTypes,
  Handle,
  Position,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

type SourceType = 'mcp' | 'http' | 'csv' | 'browser' | 'file' | 'registry' | 'other';

interface SourceConfig {
  type: SourceType;
  name: string;
  endpoint?: string;
  mcpServer?: string;
  tool?: string;
  notes?: string;
}

interface CanvasNodeData {
  label: string;
  stage: 'connect' | 'understand' | 'enrich' | 'act' | 'control';
  capability?: string;
  source?: SourceConfig;
  [key: string]: unknown;
}

const STAGE_COLORS: Record<string, string> = {
  connect: '#2563eb',
  understand: '#d97706',
  enrich: '#16a34a',
  act: '#9333ea',
  control: '#6b7280',
};

function CustomNode({ data }: { data: CanvasNodeData }) {
  const color = STAGE_COLORS[data.stage] || '#6b7280';
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 8,
        border: `2px solid ${color}`,
        background: '#fff',
        minWidth: 180,
        fontSize: 13,
        boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ fontWeight: 600, color }}>{data.label}</div>
      {data.capability && (
        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>{data.capability}</div>
      )}
      {data.source && (
        <div style={{ fontSize: 11, marginTop: 6, color: '#1f2937' }}>
          <strong>Source:</strong> {data.source.type.toUpperCase()}
          {data.source.name && ` · ${data.source.name}`}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes: NodeTypes = { custom: CustomNode };

const PALETTE = [
  { stage: 'connect' as const, label: 'MCP Source', capability: 'core.mcp_call@1', defaultSource: { type: 'mcp' as const, name: '' } },
  { stage: 'connect' as const, label: 'HTTP Source', capability: 'core.http_request@1', defaultSource: { type: 'http' as const, name: '' } },
  { stage: 'connect' as const, label: 'CSV Source', capability: 'core.csv_parse@1', defaultSource: { type: 'csv' as const, name: '' } },
  { stage: 'connect' as const, label: 'Browser Source', capability: 'core.browser_fetch@1', defaultSource: { type: 'browser' as const, name: '' } },
  { stage: 'understand' as const, label: 'Resolve Entities', capability: 'market.resolve_entities@1' },
  { stage: 'understand' as const, label: 'Ingest Observation', capability: 'market.ingest_observation@1' },
  { stage: 'enrich' as const, label: 'Map Fields', capability: 'market.map_fields@1' },
  { stage: 'act' as const, label: 'Detect Signal', capability: 'market.detect_signal@1' },
  { stage: 'control' as const, label: 'For Each', capability: 'core.for_each@1' },
];

let idCounter = 1;

export default function WorkflowCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CanvasNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<Node<CanvasNodeData> | null>(null);
  const [workflowName, setWorkflowName] = useState('New Canvas Workflow');

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges],
  );

  const addNode = (item: (typeof PALETTE)[number]) => {
    const id = `node_${idCounter++}`;
    const newNode: Node<CanvasNodeData> = {
      id,
      type: 'custom',
      position: { x: 100 + Math.random() * 200, y: 100 + Math.random() * 150 },
      data: {
        label: item.label,
        stage: item.stage,
        capability: item.capability,
        source: item.defaultSource ? { ...item.defaultSource, name: item.label } : undefined,
      },
    };
    setNodes((nds) => [...nds, newNode]);
  };

  const updateSelectedSource = (patch: Partial<SourceConfig>) => {
    if (!selected) return;
    setNodes((nds) =>
      nds.map((n) =>
        n.id === selected.id
          ? {
              ...n,
              data: {
                ...n.data,
                source: { ...(n.data.source || { type: 'other', name: '' }), ...patch },
              },
            }
          : n,
      ),
    );
    setSelected((s) =>
      s
        ? {
            ...s,
            data: {
              ...s.data,
              source: { ...(s.data.source || { type: 'other', name: '' }), ...patch },
            },
          }
        : s,
    );
  };

  const exportSpec = () => {
    const spec = {
      key: workflowName.toLowerCase().replace(/\s+/g, '.'),
      title: workflowName,
      description: 'Created via visual canvas. Sources may be MCP, HTTP, CSV, or other.',
      nodes: nodes.map((n) => ({
        id: n.id,
        capability: n.data.capability,
        config: n.data.source || {},
        input: {},
      })),
      edges: edges.map((e) => ({ from: e.source, to: e.target })),
    };
    const blob = new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${spec.key}.workflow.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 120px)', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
      {/* Palette */}
      <div style={{ width: 220, background: '#f9fafb', borderRight: '1px solid #e5e7eb', padding: 12, overflowY: 'auto' }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Node Palette</div>
        {(['connect', 'understand', 'enrich', 'act', 'control'] as const).map((stage) => (
          <div key={stage} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: STAGE_COLORS[stage], marginBottom: 4 }}>
              {stage}
            </div>
            {PALETTE.filter((p) => p.stage === stage).map((item) => (
              <button
                key={item.label}
                onClick={() => addNode(item)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 8px',
                  marginBottom: 4,
                  border: '1px solid #e5e7eb',
                  borderRadius: 6,
                  background: '#fff',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, position: 'relative' }}>
        <div style={{ position: 'absolute', top: 8, left: 8, zIndex: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={workflowName}
            onChange={(e) => setWorkflowName(e.target.value)}
            style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 14 }}
          />
          <button onClick={exportSpec} style={{ padding: '4px 12px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
            Export Spec
          </button>
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => setSelected(node)}
          fitView
        >
          <Controls />
          <MiniMap />
          <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
        </ReactFlow>
      </div>

      {/* Inspector */}
      <div style={{ width: 280, background: '#f9fafb', borderLeft: '1px solid #e5e7eb', padding: 12, overflowY: 'auto' }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Inspector</div>
        {!selected ? (
          <div style={{ color: '#6b7280', fontSize: 13 }}>Select a node to configure it.</div>
        ) : (
          <div>
            <div style={{ marginBottom: 8 }}>
              <strong>{selected.data.label}</strong>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{selected.data.capability}</div>
            </div>
            {selected.data.source && (
              <div>
                <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Source type</label>
                <select
                  value={selected.data.source.type}
                  onChange={(e) => updateSelectedSource({ type: e.target.value as SourceType })}
                  style={{ width: '100%', padding: 6, marginBottom: 8, borderRadius: 4, border: '1px solid #d1d5db' }}
                >
                  <option value="mcp">MCP</option>
                  <option value="http">HTTP</option>
                  <option value="csv">CSV</option>
                  <option value="browser">Browser</option>
                  <option value="file">File</option>
                  <option value="registry">Registry</option>
                  <option value="other">Other</option>
                </select>
                <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Name / key</label>
                <input
                  value={selected.data.source.name}
                  onChange={(e) => updateSelectedSource({ name: e.target.value })}
                  style={{ width: '100%', padding: 6, marginBottom: 8, borderRadius: 4, border: '1px solid #d1d5db' }}
                />
                {selected.data.source.type === 'mcp' && (
                  <>
                    <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>MCP server</label>
                    <input
                      value={selected.data.source.mcpServer || ''}
                      onChange={(e) => updateSelectedSource({ mcpServer: e.target.value })}
                      placeholder="e.g. company-data"
                      style={{ width: '100%', padding: 6, marginBottom: 8, borderRadius: 4, border: '1px solid #d1d5db' }}
                    />
                    <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Tool</label>
                    <input
                      value={selected.data.source.tool || ''}
                      onChange={(e) => updateSelectedSource({ tool: e.target.value })}
                      placeholder="e.g. fetch_company"
                      style={{ width: '100%', padding: 6, marginBottom: 8, borderRadius: 4, border: '1px solid #d1d5db' }}
                    />
                  </>
                )}
                {(selected.data.source.type === 'http' || selected.data.source.type === 'browser') && (
                  <>
                    <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Endpoint / URL</label>
                    <input
                      value={selected.data.source.endpoint || ''}
                      onChange={(e) => updateSelectedSource({ endpoint: e.target.value })}
                      placeholder="https://..."
                      style={{ width: '100%', padding: 6, marginBottom: 8, borderRadius: 4, border: '1px solid #d1d5db' }}
                    />
                  </>
                )}
                <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Notes</label>
                <textarea
                  value={selected.data.source.notes || ''}
                  onChange={(e) => updateSelectedSource({ notes: e.target.value })}
                  rows={3}
                  style={{ width: '100%', padding: 6, borderRadius: 4, border: '1px solid #d1d5db' }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
