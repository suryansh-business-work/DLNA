import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChevronDown,
  faChevronRight,
  faCircleInfo,
  faCloud,
  faDisplay,
  faTowerBroadcast,
  faWifi,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';

import type { Device, DeviceCategory } from '@shared/types';
import { CATEGORY_ICONS, CATEGORY_LABELS, brandIcon } from '../lib/icons';
import {
  buildTopology,
  relatedNodeIds,
  type TopologyNode,
  type TopologyNodeData,
} from '../lib/topology';

interface Props {
  devices: Device[];
  selectedId: string | null;
  hasInternet: boolean;
  onSelect: (deviceId: string | null) => void;
}

/* ------------------------------------------------------------------ node */

const KIND_ICONS = {
  internet: faCloud,
  router: faWifi,
  ap: faTowerBroadcast,
} as const;

function TopologyNodeCard({ data, selected }: NodeProps<TopologyNode>): React.JSX.Element {
  const { kind, label, sublabel, color, device, count, collapsed, online, canPlay, dimmed } = data;

  if (kind === 'group') {
    return (
      <Paper
        elevation={0}
        sx={{
          px: 1.2,
          py: 0.7,
          minWidth: 190,
          borderColor: color,
          bgcolor: `color-mix(in srgb, ${color} 12%, #131a27)`,
          cursor: 'pointer',
          opacity: dimmed ? 0.2 : 1,
          transition: 'transform .12s, opacity .2s',
          '&:hover': { transform: 'translateY(-1px)' },
        }}
      >
        <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {/* Its own button so clicking the rest of the card focuses the
              branch instead of collapsing it. */}
          <IconButton
            className="nodrag nopan"
            size="small"
            aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
            onClick={(event) => {
              event.stopPropagation();
              if (data.category) data.onToggleCollapse?.(data.category);
            }}
            sx={{ width: 20, height: 20, color }}
          >
            <FontAwesomeIcon
              icon={collapsed ? faChevronRight : faChevronDown}
              style={{ fontSize: 10 }}
            />
          </IconButton>
          <FontAwesomeIcon
            icon={CATEGORY_ICONS[data.category as DeviceCategory]}
            style={{ color, fontSize: 13 }}
          />
          <Typography variant="body2" sx={{ fontWeight: 600, color, flex: 1 }}>
            {label}
          </Typography>
          <Chip
            size="small"
            label={count}
            sx={{
              height: 19,
              fontSize: 11,
              bgcolor: `color-mix(in srgb, ${color} 22%, transparent)`,
              color,
            }}
          />
        </Stack>
        <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      </Paper>
    );
  }

  const isInfrastructure = kind === 'internet' || kind === 'router' || kind === 'ap';
  const icon =
    kind === 'device'
      ? (brandIcon(device?.vendor, device?.manufacturer, device?.model, device?.name) ??
        CATEGORY_ICONS[(device?.category ?? 'unknown') as DeviceCategory])
      : KIND_ICONS[kind as keyof typeof KIND_ICONS];

  return (
    <Tooltip
      arrow
      placement="right"
      title={
        device ? (
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {device.name}
            </Typography>
            <Typography variant="caption" component="div" sx={{ color: 'text.secondary' }}>
              {device.ip}
              {device.mac ? ` · ${device.mac}` : ''}
            </Typography>
            {device.vendor && (
              <Typography variant="caption" component="div" sx={{ color: 'text.secondary' }}>
                {device.vendor}
              </Typography>
            )}
            <Typography variant="caption" component="div" sx={{ color: 'text.secondary', mt: 0.5 }}>
              {CATEGORY_LABELS[device.category]} · {Math.round(device.confidence * 100)}% confidence
            </Typography>
            {device.openPorts.length > 0 && (
              <Typography variant="caption" component="div" sx={{ color: 'text.disabled' }}>
                Ports: {device.openPorts.map((port) => port.port).join(', ')}
              </Typography>
            )}
          </Box>
        ) : (
          label
        )
      }
    >
      <Paper
        elevation={selected ? 8 : 0}
        sx={{
          px: 1.4,
          py: 1,
          minWidth: isInfrastructure ? 210 : 190,
          maxWidth: 226,
          borderColor: selected ? 'primary.main' : 'divider',
          boxShadow: selected ? `0 0 0 1px #38bdf8` : 'none',
          bgcolor: isInfrastructure ? `color-mix(in srgb, ${color} 10%, #131a27)` : 'background.paper',
          cursor: device ? 'pointer' : 'default',
          opacity: dimmed ? 0.18 : 1,
          transition: 'transform .12s, border-color .12s, opacity .2s',
          '&:hover': { transform: device ? 'translateY(-1px)' : 'none', borderColor: color },
        }}
      >
        <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />

        <Stack direction="row" spacing={1.1} sx={{ alignItems: 'center' }}>
          <Box
            sx={{
              width: 28,
              height: 28,
              flexShrink: 0,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 1.2,
              fontSize: 13,
              color,
              bgcolor: `color-mix(in srgb, ${color} 15%, transparent)`,
              border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
            }}
          >
            <FontAwesomeIcon icon={icon} />
          </Box>

          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Stack direction="row" spacing={0.7} sx={{ alignItems: 'center' }}>
              {online !== undefined && (
                <Box
                  sx={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    flexShrink: 0,
                    bgcolor: online ? 'success.main' : 'text.disabled',
                    boxShadow: online ? '0 0 6px #34d399' : 'none',
                  }}
                />
              )}
              <Typography
                variant="body2"
                noWrap
                sx={{ fontWeight: 600, fontSize: 12.5, flex: 1, minWidth: 0 }}
              >
                {label}
              </Typography>
              {canPlay && (
                <FontAwesomeIcon icon={faDisplay} style={{ color: '#34d399', fontSize: 10 }} />
              )}
            </Stack>
            {sublabel && (
              <Typography
                variant="caption"
                noWrap
                sx={{ color: 'primary.main', fontFamily: 'Consolas, monospace', display: 'block' }}
              >
                {sublabel}
              </Typography>
            )}
          </Box>
        </Stack>

        <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      </Paper>
    </Tooltip>
  );
}

const nodeTypes: NodeTypes = { topology: TopologyNodeCard };

/* ----------------------------------------------------------------- graph */

function TopologyCanvas({ devices, selectedId, hasInternet, onSelect }: Props): React.JSX.Element {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const { fitView } = useReactFlow();

  const toggleCollapse = useCallback((category: DeviceCategory) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }, []);

  const graph = useMemo(
    () => buildTopology(devices, { collapsedGroups, hasInternet }),
    [devices, collapsedGroups, hasInternet],
  );

  /** Nodes on the focused branch; `null` means nothing is focused. */
  const related = useMemo(
    () => (focusId ? relatedNodeIds(graph.edges, focusId) : null),
    [focusId, graph.edges],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<TopologyNode>(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);

  // Re-layout whenever the device list, collapsed set or focus changes.
  useEffect(() => {
    setNodes(
      graph.nodes.map((node) => ({
        ...node,
        selected: node.data.device?.id === selectedId,
        data: {
          ...node.data,
          dimmed: related ? !related.has(node.id) : false,
          onToggleCollapse: toggleCollapse,
        },
      })),
    );

    setEdges(
      graph.edges.map((item) => {
        const onBranch = related ? related.has(item.source) && related.has(item.target) : true;
        const baseOpacity = Number(item.style?.opacity ?? 1);
        return {
          ...item,
          animated: item.animated || (Boolean(related) && onBranch),
          style: {
            ...item.style,
            opacity: onBranch ? baseOpacity : 0.06,
            strokeWidth: onBranch && related ? 2.4 : (item.style?.strokeWidth ?? 1.6),
          },
        };
      }),
    );
  }, [graph, selectedId, related, toggleCollapse, setNodes, setEdges]);

  // Clear the focus when the focused node disappears from a later scan.
  useEffect(() => {
    if (focusId && !graph.nodes.some((node) => node.id === focusId)) setFocusId(null);
  }, [graph.nodes, focusId]);

  // Fit once there is something to fit, and again when the shape changes a lot.
  useEffect(() => {
    if (graph.nodes.length === 0) return;
    const timer = setTimeout(() => void fitView({ padding: 0.18, duration: 350 }), 80);
    return () => clearTimeout(timer);
  }, [graph.nodes.length, fitView]);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: TopologyNode) => {
      const { device } = node.data as TopologyNodeData;

      // Clicking the same node again clears the focus.
      setFocusId((current) => (current === node.id ? null : node.id));
      if (device) onSelect(device.id === selectedId ? null : device.id);
    },
    [onSelect, selectedId],
  );

  const clearFocus = useCallback(() => {
    setFocusId(null);
    onSelect(null);
  }, [onSelect]);

  const focusedNode = focusId ? graph.nodes.find((node) => node.id === focusId) : undefined;

  return (
    <>
    {/* A mesh node has no client edges to light up, and the reason is not
        obvious from the canvas, so say it where the question is asked. */}
    {focusedNode?.data.kind === 'ap' && (
      <Alert
        severity="info"
        icon={<FontAwesomeIcon icon={faCircleInfo} />}
        sx={{
          position: 'absolute',
          top: 12,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 6,
          maxWidth: 560,
          bgcolor: 'rgba(15, 20, 31, 0.96)',
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.3 }}>
          {focusedNode.data.label} — client list not available
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.5 }}>
          Which devices are joined to this mesh node lives inside the router, not
          on the wire — a passive scan cannot see Wi-Fi association. Its uplink to
          the router is highlighted because that part is observable.
        </Typography>
      </Alert>
    )}
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={onNodeClick}
      onPaneClick={clearFocus}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.15}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      nodesConnectable={false}
      elevateNodesOnSelect
      style={{ background: 'transparent' }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1c2536" />
      {/* Top-left keeps the zoom controls clear of the legend button. */}
      <Controls
        position="top-left"
        showInteractive={false}
        style={{ background: '#131a27', border: '1px solid #212b3d', borderRadius: 8 }}
      />
      <MiniMap
        pannable
        zoomable
        nodeColor={(node) => (node.data as TopologyNodeData).color}
        maskColor="rgba(8, 11, 18, 0.75)"
        style={{ background: '#0f141f', border: '1px solid #212b3d', borderRadius: 8 }}
      />
    </ReactFlow>
    </>
  );
}

/* ------------------------------------------------------------------ shell */

export function TopologyGraph(props: Props): React.JSX.Element {
  return (
    <Box sx={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <ReactFlowProvider>
        <TopologyCanvas {...props} />
      </ReactFlowProvider>

      <Legend />
    </Box>
  );
}

/**
 * Legend for the edge styles.
 *
 * Collapsed to a single button by default: the canvas is the content, and a
 * permanent panel in a corner sits on top of whichever column lands there.
 */
function Legend(): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <Box sx={{ position: 'absolute', left: 14, bottom: 14, zIndex: 5 }}>
      {open ? (
        <Paper
          elevation={0}
          sx={{ px: 1.6, py: 1.2, maxWidth: 290, bgcolor: 'rgba(15, 20, 31, 0.94)', backdropFilter: 'blur(8px)' }}
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.6 }}>
            <Typography
              variant="caption"
              sx={{ fontWeight: 700, letterSpacing: '.07em', color: 'text.disabled', flex: 1 }}
            >
              HOW TO READ THIS
            </Typography>
            <IconButton size="small" onClick={() => setOpen(false)} aria-label="Hide legend">
              <FontAwesomeIcon icon={faXmark} style={{ fontSize: 12 }} />
            </IconButton>
          </Stack>
          <Divider sx={{ mb: 0.9 }} />
          <Stack spacing={0.7}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Box sx={{ width: 26, height: 2, bgcolor: '#fbbf24', borderRadius: 1, flexShrink: 0 }} />
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Real uplink (mesh node → router)
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Box sx={{ width: 26, borderTop: '2px dashed #8899b0', opacity: 0.8, flexShrink: 0 }} />
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Logical grouping, not a measured link
              </Typography>
            </Stack>
          </Stack>
          <Typography
            variant="caption"
            sx={{ display: 'block', mt: 1, color: 'text.disabled', lineHeight: 1.45 }}
          >
            Which access point a client is joined to cannot be seen from a passive
            scan, so client links are dashed. Click a group to collapse it.
          </Typography>
        </Paper>
      ) : (
        <Tooltip title="What do the lines mean?" placement="right" arrow>
          <IconButton
            onClick={() => setOpen(true)}
            sx={{
              bgcolor: 'rgba(15, 20, 31, 0.94)',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 2,
              width: 34,
              height: 34,
            }}
            aria-label="Show legend"
          >
            <FontAwesomeIcon icon={faCircleInfo} style={{ fontSize: 14, color: '#8899b0' }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}

/** Grid / graph switcher used in the toolbar. */
export function ViewSwitch({
  view,
  onChange,
}: {
  view: 'grid' | 'graph';
  onChange: (view: 'grid' | 'graph') => void;
}): React.JSX.Element {
  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={view}
      onChange={(_event, next: 'grid' | 'graph' | null) => next && onChange(next)}
    >
      <ToggleButton value="grid">Cards</ToggleButton>
      <ToggleButton value="graph">Topology</ToggleButton>
    </ToggleButtonGroup>
  );
}
