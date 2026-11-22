'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  capabilityType: string;
  capabilityVersion: number;
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
        minWidth: 190,
        fontSize: 13,
        boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ fontWeight: 600, color }}>{data.label}</div>
      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
        {data.capabilityType}@{data.capabilityVersion}
      </div>
      {data.source && (
        <div style={{ fontSize: 11, marginTop: 6, color: '#1f2937' }}>
          <strong>Source:</strong> {data.source.type.toUpperCase()}
          {data.source.name ? ` · ${data.source.name}` : ''}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes: NodeTypes = { custom: CustomNode };

const PALETTE = [
  {
    stage: 'connect' as const,
    label: 'HTTP Source',
    capabilityType: 'core.http_request',
    capabilityVersion: 1,
    defaultSource: { type: 'http' as const, name: '' },
  },
  {
    stage: 'connect' as const,
    label: 'CSV Source',
    capabilityType: 'core.parse_csv',
    capabilityVersion: 1,
    defaultSource: { type: 'csv' as const, name: '' },
  },
  {
    stage: 'connect' as const,
    label: 'Browser Source',
    capabilityType: 'core.browser_fetch',
    capabilityVersion: 1,
    defaultSource: { type: 'browser' as const, name: '' },
  },
  {
    stage: 'enrich' as const,
    label: 'Map Fields',
    capabilityType: 'core.map_fields',
    capabilityVersion: 1,
  },
  { stage: 'control' as const, label: 'For Each', capabilityType: 'core.for_each', capabilityVersion: 1 },
  // Coming soon — not yet registered capabilities
  {
    stage: 'connect' as const,
    label: 'MCP Source',
    capabilityType: 'core.mcp_call',
    capabilityVersion: 1,
    comingSoon: true,
    defaultSource: { type: 'mcp' as const, name: '' },
  },
  {
    stage: 'understand' as const,
    label: 'Resolve Entities',
    capabilityType: 'market.resolve_entities',
    capabilityVersion: 1,
    comingSoon: true,
  },
  {
    stage: 'understand' as const,
    label: 'Ingest Observation',
    capabilityType: 'market.ingest_observation',
    capabilityVersion: 1,
    comingSoon: true,
  },
  {
    stage: 'act' as const,
    label: 'Detect Signal',
    capabilityType: 'market.detect_signal',
    capabilityVersion: 1,
    comingSoon: true,
  },
];

let idCounter = 1;

function makeNodeId(base: string): string {
  const safe =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'node';
  return `${safe}_${idCounter++}`;
}

export default function WorkflowCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CanvasNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<Node<CanvasNodeData> | null>(null);
  const [workflowName, setWorkflowName] = useState('New Canvas Workflow');
  const [showPreview, setShowPreview] = useState(false);
  const [validationMsg, setValidationMsg] = useState<string | null>(null);
  const [registerMsg, setRegisterMsg] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [sources, setSources] = useState<
    Array<{ _id: string; key?: string; name?: string; provider?: string }>
  >([]);

  useEffect(() => {
    fetch('/api/sources?limit=100')
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data) => setSources(data.items || []))
      .catch(() => setSources([]));
  }, []);

  const onConnect = useCallback((params: Connection) => setEdges((eds) => addEdge(params, eds)), [setEdges]);

  const addNode = (item: (typeof PALETTE)[number]) => {
    if (item.comingSoon) return;
    const id = makeNodeId(item.label);
    const newNode: Node<CanvasNodeData> = {
      id,
      type: 'custom',
      position: { x: 120 + Math.random() * 220, y: 80 + Math.random() * 180 },
      data: {
        label: item.label,
        stage: item.stage,
        capabilityType: item.capabilityType,
        capabilityVersion: item.capabilityVersion,
        source: item.defaultSource ? { ...item.defaultSource, name: item.label } : undefined,
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setValidationMsg(null);
  };

  const updateSelected = (patch: Partial<CanvasNodeData>) => {
    if (!selected) return;
    setNodes((nds) => nds.map((n) => (n.id === selected.id ? { ...n, data: { ...n.data, ...patch } } : n)));
    setSelected((s) => (s ? { ...s, data: { ...s.data, ...patch } } : s));
  };

  const updateSelectedSource = (patch: Partial<SourceConfig>) => {
    if (!selected) return;
    const nextSource = { ...(selected.data.source || { type: 'other' as const, name: '' }), ...patch };
    updateSelected({ source: nextSource });
  };

  const generatedSpec = useMemo(() => {
    const key =
      workflowName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '.')
        .replace(/^\.+|\.+$/g, '')
        .replace(/\.{2,}/g, '.') || 'canvas.workflow';
    return {
      key: key.length >= 3 ? key : `canvas.${key}`,
      title: workflowName,
      description:
        'Created via visual canvas. Sources may be MCP, HTTP, CSV, browser, file, registry, or other.',
      nodes: nodes.map((n) => ({
        id: n.id,
        title: n.data.label,
        capability: { type: n.data.capabilityType, version: n.data.capabilityVersion },
        config: n.data.source
          ? {
              sourceType: n.data.source.type,
              sourceName: n.data.source.name,
              endpoint: n.data.source.endpoint,
              mcpServer: n.data.source.mcpServer,
              tool: n.data.source.tool,
              notes: n.data.source.notes,
            }
          : {},
        input: {},
      })),
      edges: edges.map((e) => ({ from: e.source, to: e.target })),
    };
  }, [nodes, edges, workflowName]);

  const validate = (): string | null => {
    if (nodes.length === 0) return 'Add at least one node.';
    if (!/^[a-z][a-z0-9_.-]{2,127}$/.test(generatedSpec.key)) {
      return 'Workflow key must start with a letter and contain only lowercase letters, numbers, dots, underscores or hyphens (3–128 chars).';
    }
    const ids = new Set(nodes.map((n) => n.id));
    for (const e of edges) {
      if (!ids.has(e.source) || !ids.has(e.target)) return 'Edge references a missing node.';
      if (e.source === e.target) return 'Self-loops are not allowed.';
    }
    return null;
  };

  const exportSpec = () => {
    const err = validate();
    if (err) {
      setValidationMsg(err);
      return;
    }
    setValidationMsg(null);
    const blob = new Blob([JSON.stringify(generatedSpec, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${generatedSpec.key}.workflow.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const registerSpec = async () => {
    const err = validate();
    if (err) {
      setValidationMsg(err);
      setRegisterMsg(null);
      return;
    }
    setValidationMsg(null);
    setRegistering(true);
    setRegisterMsg(null);
    try {
      const res = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(generatedSpec),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRegisterMsg(data.error?.message || data.message || `Registration failed (${res.status})`);
      } else {
        setRegisterMsg(
          data.created
            ? `Registered as ${data.key} (version ${data.version})`
            : `Already registered as ${data.key} (version ${data.version})`,
        );
      }
    } catch (e) {
      setRegisterMsg(e instanceof Error ? e.message : 'Network error');
    } finally {
      setRegistering(false);
    }
  };

  const loadTemplate = (kind: 'mcp-resolve' | 'http-csv') => {
    idCounter = 1;
    if (kind === 'mcp-resolve') {
      // MCP / resolve / detect are coming soon; use available capabilities only.
      const n1: Node<CanvasNodeData> = {
        id: makeNodeId('http'),
        type: 'custom',
        position: { x: 80, y: 120 },
        data: {
          label: 'HTTP Source',
          stage: 'connect',
          capabilityType: 'core.http_request',
          capabilityVersion: 1,
          source: { type: 'http', name: 'Company feed', endpoint: 'https://example.com/companies' },
        },
      };
      const n2: Node<CanvasNodeData> = {
        id: makeNodeId('map'),
        type: 'custom',
        position: { x: 360, y: 120 },
        data: {
          label: 'Map Fields',
          stage: 'enrich',
          capabilityType: 'core.map_fields',
          capabilityVersion: 1,
        },
      };
      setNodes([n1, n2]);
      setEdges([{ id: 'e1', source: n1.id, target: n2.id }]);
      setWorkflowName('HTTP Map Fields');
    } else {
      const n1: Node<CanvasNodeData> = {
        id: makeNodeId('http'),
        type: 'custom',
        position: { x: 80, y: 80 },
        data: {
          label: 'HTTP Source',
          stage: 'connect',
          capabilityType: 'core.http_request',
          capabilityVersion: 1,
          source: { type: 'http', name: 'Careers page', endpoint: 'https://example.com/jobs' },
        },
      };
      const n2: Node<CanvasNodeData> = {
        id: makeNodeId('csv'),
        type: 'custom',
        position: { x: 80, y: 220 },
        data: {
          label: 'CSV Source',
          stage: 'connect',
          capabilityType: 'core.parse_csv',
          capabilityVersion: 1,
          source: { type: 'csv', name: 'Directory CSV' },
        },
      };
      const n3: Node<CanvasNodeData> = {
        id: makeNodeId('map'),
        type: 'custom',
        position: { x: 380, y: 150 },
        data: {
          label: 'Map Fields',
          stage: 'enrich',
          capabilityType: 'core.map_fields',
          capabilityVersion: 1,
        },
      };
      setNodes([n1, n2, n3]);
      setEdges([
        { id: 'e1', source: n1.id, target: n3.id },
        { id: 'e2', source: n2.id, target: n3.id },
      ]);
      setWorkflowName('HTTP + CSV Map');
    }
    setSelected(null);
    setValidationMsg(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 160px)', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={workflowName}
          onChange={(e) => setWorkflowName(e.target.value)}
          style={{
            padding: '6px 10px',
            border: '1px solid #d1d5db',
            borderRadius: 6,
            fontSize: 14,
            minWidth: 240,
          }}
          placeholder="Workflow name"
        />
        <button
          onClick={() => loadTemplate('mcp-resolve')}
          style={{
            padding: '6px 12px',
            border: '1px solid #d1d5db',
            borderRadius: 6,
            background: '#fff',
            cursor: 'pointer',
          }}
        >
          Template: MCP → Resolve → Signal
        </button>
        <button
          onClick={() => loadTemplate('http-csv')}
          style={{
            padding: '6px 12px',
            border: '1px solid #d1d5db',
            borderRadius: 6,
            background: '#fff',
            cursor: 'pointer',
          }}
        >
          Template: HTTP + CSV → Resolve
        </button>
        <button
          onClick={exportSpec}
          style={{
            padding: '6px 14px',
            background: '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Export Spec
        </button>
        <button
          onClick={registerSpec}
          disabled={registering}
          style={{
            padding: '6px 14px',
            background: '#16a34a',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            opacity: registering ? 0.6 : 1,
          }}
        >
          {registering ? 'Registering…' : 'Register Workflow'}
        </button>
        <button
          onClick={() => setShowPreview((v) => !v)}
          style={{
            padding: '6px 12px',
            border: '1px solid #d1d5db',
            borderRadius: 6,
            background: '#fff',
            cursor: 'pointer',
          }}
        >
          {showPreview ? 'Hide' : 'Show'} Spec Preview
        </button>
      </div>
      {validationMsg && (
        <div
          style={{
            padding: '8px 12px',
            background: '#fef2f2',
            color: '#991b1b',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          {validationMsg}
        </div>
      )}
      {registerMsg && (
        <div
          style={{
            padding: '8px 12px',
            background:
              registerMsg.startsWith('Registered') || registerMsg.startsWith('Already')
                ? '#f0fdf4'
                : '#fef2f2',
            color:
              registerMsg.startsWith('Registered') || registerMsg.startsWith('Already')
                ? '#166534'
                : '#991b1b',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          {registerMsg}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          flex: 1,
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          overflow: 'hidden',
          minHeight: 480,
        }}
      >
        {/* Palette */}
        <div
          style={{
            width: 220,
            background: '#f9fafb',
            borderRight: '1px solid #e5e7eb',
            padding: 12,
            overflowY: 'auto',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Node Palette</div>
          {(['connect', 'understand', 'enrich', 'act', 'control'] as const).map((stage) => (
            <div key={stage} style={{ marginBottom: 12 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  color: STAGE_COLORS[stage],
                  marginBottom: 4,
                }}
              >
                {stage}
              </div>
              {PALETTE.filter((p) => p.stage === stage).map((item) => (
                <button
                  key={item.label}
                  onClick={() => addNode(item)}
                  disabled={item.comingSoon}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 8px',
                    marginBottom: 4,
                    border: '1px solid #e5e7eb',
                    borderRadius: 6,
                    background: item.comingSoon ? '#f3f4f6' : '#fff',
                    cursor: item.comingSoon ? 'not-allowed' : 'pointer',
                    fontSize: 12,
                    color: item.comingSoon ? '#9ca3af' : undefined,
                    opacity: item.comingSoon ? 0.7 : 1,
                  }}
                >
                  {item.label}
                  {item.comingSoon && <span style={{ marginLeft: 6, fontSize: 10 }}>coming soon</span>}
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* Canvas */}
        <div style={{ flex: 1, position: 'relative' }}>
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
        <div
          style={{
            width: 300,
            background: '#f9fafb',
            borderLeft: '1px solid #e5e7eb',
            padding: 12,
            overflowY: 'auto',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Inspector</div>
          {!selected ? (
            <div style={{ color: '#6b7280', fontSize: 13 }}>
              Select a node to configure it. Sources can be MCP, HTTP, CSV, or any other type.
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: 8 }}>
                <strong>{selected.data.label}</strong>
                <div style={{ fontSize: 12, color: '#6b7280' }}>
                  {selected.data.capabilityType}@{selected.data.capabilityVersion}
                </div>
              </div>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Label</label>
              <input
                value={selected.data.label}
                onChange={(e) => updateSelected({ label: e.target.value })}
                style={{
                  width: '100%',
                  padding: 6,
                  marginBottom: 8,
                  borderRadius: 4,
                  border: '1px solid #d1d5db',
                }}
              />
              {selected.data.source && (
                <div>
                  {sources.length > 0 && (
                    <>
                      <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
                        Use existing source
                      </label>
                      <select
                        value=""
                        onChange={(e) => {
                          const id = e.target.value;
                          const s = sources.find((x) => x._id === id);
                          if (s) {
                            updateSelectedSource({
                              name: s.key || s.name || s._id,
                              notes: `Linked to existing source ${s.name || s.key || s._id}`,
                            });
                          }
                        }}
                        style={{
                          width: '100%',
                          padding: 6,
                          marginBottom: 8,
                          borderRadius: 4,
                          border: '1px solid #d1d5db',
                        }}
                      >
                        <option value="">— select to prefill —</option>
                        {sources.map((s) => (
                          <option key={s._id} value={s._id}>
                            {s.name || s.key || s._id} {s.provider ? `(${s.provider})` : ''}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                  <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Source type</label>
                  <select
                    value={selected.data.source.type}
                    onChange={(e) => updateSelectedSource({ type: e.target.value as SourceType })}
                    style={{
                      width: '100%',
                      padding: 6,
                      marginBottom: 8,
                      borderRadius: 4,
                      border: '1px solid #d1d5db',
                    }}
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
                    style={{
                      width: '100%',
                      padding: 6,
                      marginBottom: 8,
                      borderRadius: 4,
                      border: '1px solid #d1d5db',
                    }}
                  />
                  {selected.data.source.type === 'mcp' && (
                    <>
                      <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>MCP server</label>
                      <input
                        value={selected.data.source.mcpServer || ''}
                        onChange={(e) => updateSelectedSource({ mcpServer: e.target.value })}
                        placeholder="e.g. company-data"
                        style={{
                          width: '100%',
                          padding: 6,
                          marginBottom: 8,
                          borderRadius: 4,
                          border: '1px solid #d1d5db',
                        }}
                      />
                      <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Tool</label>
                      <input
                        value={selected.data.source.tool || ''}
                        onChange={(e) => updateSelectedSource({ tool: e.target.value })}
                        placeholder="e.g. fetch_company"
                        style={{
                          width: '100%',
                          padding: 6,
                          marginBottom: 8,
                          borderRadius: 4,
                          border: '1px solid #d1d5db',
                        }}
                      />
                    </>
                  )}
                  {(selected.data.source.type === 'http' || selected.data.source.type === 'browser') && (
                    <>
                      <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
                        Endpoint / URL
                      </label>
                      <input
                        value={selected.data.source.endpoint || ''}
                        onChange={(e) => updateSelectedSource({ endpoint: e.target.value })}
                        placeholder="https://..."
                        style={{
                          width: '100%',
                          padding: 6,
                          marginBottom: 8,
                          borderRadius: 4,
                          border: '1px solid #d1d5db',
                        }}
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
      {showPreview && (
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: '#111827',
            color: '#e5e7eb',
            borderRadius: 8,
            fontSize: 12,
            maxHeight: 220,
            overflow: 'auto',
          }}
        >
          {JSON.stringify(generatedSpec, null, 2)}
        </pre>
      )}
    </div>
  );
}
