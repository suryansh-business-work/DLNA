import type { Edge, Node } from '@xyflow/react';
import type { Device, DeviceCategory } from '@shared/types';
import { CATEGORY_COLORS, CATEGORY_LABELS, CATEGORY_ORDER } from './icons';

/**
 * Builds the React Flow graph from a device list.
 *
 * The layout is computed here rather than by a layout library because the
 * shape is known in advance - it is a fixed four-tier tree - so a hand-rolled
 * pass is both smaller and fully deterministic between renders.
 *
 * An honest note about the edges: passive scanning cannot tell which access
 * point a client is associated with. Uplinks from the router to its mesh
 * satellites are real; the links from the router down to client devices are
 * drawn dashed to show they are logical, not measured.
 */

export type TopologyNodeKind = 'internet' | 'router' | 'ap' | 'group' | 'device';

export interface TopologyNodeData extends Record<string, unknown> {
  kind: TopologyNodeKind;
  label: string;
  sublabel?: string;
  color: string;
  device?: Device;
  category?: DeviceCategory;
  count?: number;
  collapsed?: boolean;
  online?: boolean;
  canPlay?: boolean;
  /** Set while another node is focused and this one is not part of its branch. */
  dimmed?: boolean;
  /** Toggles this group's collapsed state; only present on group nodes. */
  onToggleCollapse?: (category: DeviceCategory) => void;
}

export type TopologyNode = Node<TopologyNodeData>;

const ROW_INTERNET = 0;
const ROW_ROUTER = 150;
const ROW_AP = 320;
const COLUMN_WIDTH = 250;
const DEVICE_ROW_HEIGHT = 78;
const GROUP_TOP_GAP = 150;
const DEVICE_TOP_GAP = 110;

const INTERNET_COLOR = '#64748b';
const ROUTER_COLOR = CATEGORY_COLORS.router;
const AP_COLOR = CATEGORY_COLORS['access-point'];

function edge(id: string, source: string, target: string, options: Partial<Edge> = {}): Edge {
  return {
    id,
    source,
    target,
    type: 'smoothstep',
    ...options,
    style: { stroke: '#2e3b52', strokeWidth: 1.6, ...(options.style ?? {}) },
  };
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: Edge[];
}

/**
 * Every node on the branch through `focusId`: the chain up to the root plus
 * everything hanging below it. Used to dim the rest of the graph so one
 * device, group or mesh node can be looked at in isolation.
 */
export function relatedNodeIds(edges: Edge[], focusId: string): Set<string> {
  const parent = new Map<string, string>();
  const children = new Map<string, string[]>();

  for (const item of edges) {
    parent.set(item.target, item.source);
    children.set(item.source, [...(children.get(item.source) ?? []), item.target]);
  }

  const related = new Set<string>([focusId]);

  for (let up = parent.get(focusId); up && !related.has(up); up = parent.get(up)) {
    related.add(up);
  }

  const stack = [focusId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const child of children.get(current) ?? []) {
      if (!related.has(child)) {
        related.add(child);
        stack.push(child);
      }
    }
  }

  return related;
}

export function buildTopology(
  devices: Device[],
  options: { collapsedGroups: Set<string>; hasInternet: boolean },
): TopologyGraph {
  const nodes: TopologyNode[] = [];
  const edges: Edge[] = [];

  const router = devices.find((device) => device.isGateway);
  const accessPoints = devices.filter((device) => device.category === 'access-point');

  // Everything that is neither the router nor an AP hangs off the tree as a client.
  const clients = devices.filter(
    (device) => !device.isGateway && device.category !== 'access-point',
  );

  const grouped = new Map<DeviceCategory, Device[]>();
  for (const device of clients) {
    const list = grouped.get(device.category) ?? [];
    list.push(device);
    grouped.set(device.category, list);
  }

  const groups = CATEGORY_ORDER.filter((category) => grouped.has(category)).map((category) => ({
    category,
    devices: grouped.get(category)!,
  }));

  /* ------------------------------------------------------------ geometry */

  // Width is driven by whichever tier is widest, so the tree stays centred.
  const groupSpan = Math.max(groups.length, 1) * COLUMN_WIDTH;
  const apSpan = Math.max(accessPoints.length, 1) * COLUMN_WIDTH;
  const centerX = Math.max(groupSpan, apSpan) / 2;

  const rowAp = accessPoints.length > 0 ? ROW_AP : ROW_ROUTER;
  const rowGroup = rowAp + GROUP_TOP_GAP;

  /* --------------------------------------------------------------- nodes */

  const ROUTER_ID = 'node-router';

  if (options.hasInternet) {
    nodes.push({
      id: 'node-internet',
      type: 'topology',
      position: { x: centerX - 90, y: ROW_INTERNET },
      data: { kind: 'internet', label: 'Internet', color: INTERNET_COLOR },
      draggable: false,
      selectable: false,
    });
  }

  nodes.push({
    id: ROUTER_ID,
    type: 'topology',
    position: { x: centerX - 105, y: ROW_ROUTER },
    data: {
      kind: 'router',
      label: router?.name ?? 'Router / Gateway',
      sublabel: router?.ip,
      color: ROUTER_COLOR,
      device: router,
      online: router?.online ?? true,
    },
  });

  if (options.hasInternet) {
    edges.push(
      edge('edge-wan', 'node-internet', ROUTER_ID, {
        animated: true,
        style: { stroke: '#3d4d69', strokeWidth: 2 },
      }),
    );
  }

  accessPoints.forEach((ap, index) => {
    const id = `node-ap-${ap.id}`;
    const x = (Math.max(apSpan, groupSpan) - apSpan) / 2 + index * COLUMN_WIDTH + 20;
    nodes.push({
      id,
      type: 'topology',
      position: { x, y: rowAp },
      data: {
        kind: 'ap',
        label: ap.name,
        sublabel: ap.ip,
        color: AP_COLOR,
        device: ap,
        online: ap.online,
      },
    });
    // A satellite's uplink to the router is a real link, so it is drawn solid.
    edges.push(edge(`edge-ap-${ap.id}`, ROUTER_ID, id, { style: { stroke: AP_COLOR, strokeWidth: 1.8 } }));
  });

  groups.forEach((group, index) => {
    const groupId = `node-group-${group.category}`;
    const x = (Math.max(apSpan, groupSpan) - groupSpan) / 2 + index * COLUMN_WIDTH + 20;
    const collapsed = options.collapsedGroups.has(group.category);
    const color = CATEGORY_COLORS[group.category];

    nodes.push({
      id: groupId,
      type: 'topology',
      position: { x, y: rowGroup },
      data: {
        kind: 'group',
        label: CATEGORY_LABELS[group.category],
        color,
        category: group.category,
        count: group.devices.length,
        collapsed,
      },
    });

    edges.push(
      edge(`edge-group-${group.category}`, ROUTER_ID, groupId, {
        style: { stroke: color, strokeWidth: 1.4, strokeDasharray: '5 4', opacity: 0.75 },
      }),
    );

    if (collapsed) return;

    group.devices.forEach((device, deviceIndex) => {
      const deviceId = `node-device-${device.id}`;
      nodes.push({
        id: deviceId,
        type: 'topology',
        position: { x, y: rowGroup + DEVICE_TOP_GAP + deviceIndex * DEVICE_ROW_HEIGHT },
        data: {
          kind: 'device',
          label: device.name,
          sublabel: device.ip,
          color,
          device,
          category: device.category,
          online: device.online,
          canPlay: Boolean(device.playback),
        },
      });
      edges.push(
        edge(`edge-device-${device.id}`, groupId, deviceId, {
          style: { stroke: color, strokeWidth: 1.2, strokeDasharray: '4 4', opacity: 0.55 },
        }),
      );
    });
  });

  return { nodes, edges };
}
