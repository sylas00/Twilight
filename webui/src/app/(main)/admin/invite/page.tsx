"use client";

/**
 * 邀请森林可视化（管理员）
 * ========================
 * 用 SVG 自绘一个紧凑的「星图 / 辐射树」：
 * - 每个根节点是一颗"恒星"，子节点围绕排布，越靠外层颜色越淡。
 * - 鼠标 hover 节点显示提示，点击在右侧抽屉展示用户详情。
 * - 不引入额外可视化库，方便部署到 Cloudflare Workers（rendering tree small）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  GitBranch,
  Loader2,
  RefreshCw,
  Network,
  Crown,
  Ban,
  Trash2,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { api, type InviteForest, type InviteForestNode } from "@/lib/api";
import {
  Sheet,
  SheetClose,
} from "./sheet-mini";

interface Positioned {
  uid: number;
  x: number;
  y: number;
  depth: number;
  angle: number;
  rootUid: number;
}

interface StarSystem {
  rootUid: number;
  x: number;
  y: number;
  radius: number;
  depth: number;
  count: number;
}

interface PlacedForest {
  positions: Map<number, Positioned>;
  systems: StarSystem[];
  width: number;
  height: number;
}

const DEPTH_COLOR_LIGHT = ["#38bdf8", "#34d399", "#c084fc", "#fbbf24", "#fb7185", "#60a5fa"];

function seededUnit(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function buildChildrenMap(forest: InviteForest): Map<number, number[]> {
  const childrenMap = new Map<number, number[]>();
  for (const e of forest.edges) {
    if (!childrenMap.has(e.parent)) childrenMap.set(e.parent, []);
    childrenMap.get(e.parent)!.push(e.child);
  }
  for (const children of childrenMap.values()) children.sort((a, b) => a - b);
  return childrenMap;
}

function countSubtree(root: number, childrenMap: Map<number, number[]>): { count: number; depth: number } {
  let count = 0;
  let depth = 1;
  const queue: Array<{ uid: number; d: number }> = [{ uid: root, d: 1 }];
  const seen = new Set<number>([root]);
  while (queue.length) {
    const { uid, d } = queue.shift()!;
    count += 1;
    depth = Math.max(depth, d);
    for (const child of childrenMap.get(uid) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push({ uid: child, d: d + 1 });
    }
  }
  return { count, depth };
}

function placeForest(forest: InviteForest): PlacedForest {
  const childrenMap = buildChildrenMap(forest);

  const positions = new Map<number, Positioned>();
  const systems: StarSystem[] = [];
  const roots = [...forest.roots].sort((a, b) => a - b);
  const metrics = roots.map((rootUid) => ({ rootUid, ...countSubtree(rootUid, childrenMap) }));
  const cols = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(Math.max(1, roots.length)))));
  const baseRadius = Math.max(
    150,
    ...metrics.map((m) => Math.max(128, 72 * Math.max(1, m.depth - 1) + Math.min(80, m.count * 4))),
  );
  const cellW = baseRadius * 2 + 180;
  const cellH = baseRadius * 2 + 150;
  const rows = Math.max(1, Math.ceil(roots.length / cols));

  metrics.forEach((metric, index) => {
    const rootUid = metric.rootUid;
    const col = index % cols;
    const row = Math.floor(index / cols);
    const centerX = 90 + col * cellW + cellW / 2;
    const centerY = 88 + row * cellH + cellH / 2;
    const radius = Math.max(120, 72 * Math.max(1, metric.depth - 1) + Math.min(70, metric.count * 3));
    systems.push({ rootUid, x: centerX, y: centerY, radius, depth: metric.depth, count: metric.count });

    positions.set(rootUid, { uid: rootUid, x: centerX, y: centerY, depth: 1, angle: -Math.PI / 2, rootUid });

    const queue: Array<{ uid: number; angle: number; depth: number; sliceStart: number; sliceEnd: number }> =
      [{ uid: rootUid, angle: -Math.PI / 2, depth: 1, sliceStart: -Math.PI, sliceEnd: Math.PI }];

    while (queue.length) {
      const item = queue.shift()!;
      const children = childrenMap.get(item.uid) || [];
      if (children.length === 0) continue;
      const sliceSize = (item.sliceEnd - item.sliceStart) / children.length;
      children.forEach((child, idx) => {
        const childAngle = item.sliceStart + sliceSize * (idx + 0.5);
        const jitter = (seededUnit(child * 31 + rootUid) - 0.5) * 20;
        const r = Math.min(radius, item.depth * 74 + jitter);
        const px = centerX + Math.cos(childAngle) * r;
        const py = centerY + Math.sin(childAngle) * r;
        positions.set(child, { uid: child, x: px, y: py, depth: item.depth + 1, angle: childAngle, rootUid });
        queue.push({
          uid: child,
          angle: childAngle,
          depth: item.depth + 1,
          sliceStart: item.sliceStart + sliceSize * idx,
          sliceEnd: item.sliceStart + sliceSize * (idx + 1),
        });
      });
    }
  });

  return {
    positions,
    systems,
    width: Math.max(cols * cellW + 180, 900),
    height: Math.max(rows * cellH + 170, 560),
  };
}

function depthColor(depth: number): string {
  return DEPTH_COLOR_LIGHT[(depth - 1) % DEPTH_COLOR_LIGHT.length];
}

function nodeColor(node: InviteForestNode, depth: number): string {
  if (!node.active) return "#64748b";
  if (node.role === 0) return "#fbbf24";
  if (node.role === 2) return "#22d3ee";
  if (!node.emby_id) return "#94a3b8";
  return depthColor(depth);
}

function nodeRadius(node: InviteForestNode, depth: number): number {
  if (depth === 1) return 18;
  if (node.role === 0) return 14;
  if (node.role === 2) return 12;
  return node.emby_id ? 10 : 8;
}

function makeStarfield(width: number, height: number): Array<{ x: number; y: number; r: number; o: number }> {
  const count = Math.min(220, Math.max(80, Math.floor((width * height) / 15000)));
  return Array.from({ length: count }, (_, index) => ({
    x: seededUnit(index + 13) * width,
    y: seededUnit(index + 97) * height,
    r: 0.45 + seededUnit(index + 181) * 1.35,
    o: 0.18 + seededUnit(index + 311) * 0.45,
  }));
}

function edgePath(parent: Positioned, child: Positioned): string {
  const mx = (parent.x + child.x) / 2;
  const my = (parent.y + child.y) / 2;
  const dx = child.x - parent.x;
  const dy = child.y - parent.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const bend = Math.min(38, len * 0.18) * (child.angle >= 0 ? 1 : -1);
  const cx = mx + (-dy / len) * bend;
  const cy = my + (dx / len) * bend;
  return `M ${parent.x} ${parent.y} Q ${cx} ${cy} ${child.x} ${child.y}`;
}

function findRoot(forest: InviteForest, uid: number): number {
  const parentOf = new Map<number, number>();
  for (const e of forest.edges) parentOf.set(e.child, e.parent);
  let cur = uid;
  const visited = new Set<number>([cur]);
  while (parentOf.has(cur)) {
    cur = parentOf.get(cur)!;
    if (visited.has(cur)) break;
    visited.add(cur);
  }
  return cur;
}

function relationHighlight(forest: InviteForest | null, selectedUid: number | null): Set<string> {
  const highlighted = new Set<string>();
  if (!forest || !selectedUid) return highlighted;
  const childrenMap = buildChildrenMap(forest);
  const parentOf = new Map<number, number>();
  for (const edge of forest.edges) parentOf.set(edge.child, edge.parent);

  let cur = selectedUid;
  const seen = new Set<number>([cur]);
  while (parentOf.has(cur)) {
    const parent = parentOf.get(cur)!;
    highlighted.add(`${parent}-${cur}`);
    if (seen.has(parent)) break;
    seen.add(parent);
    cur = parent;
  }

  const queue = [selectedUid];
  while (queue.length) {
    const uid = queue.shift()!;
    for (const child of childrenMap.get(uid) || []) {
      highlighted.add(`${uid}-${child}`);
      queue.push(child);
    }
  }
  return highlighted;
}

export default function AdminInviteTreePage() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [forest, setForest] = useState<InviteForest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.adminGetInviteTree();
      if (res.success && res.data) {
        setForest(res.data);
      } else {
        throw new Error(res.message || "加载失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const placed = useMemo(() => (forest ? placeForest(forest) : null), [forest]);
  const starfield = useMemo(() => (placed ? makeStarfield(placed.width, placed.height) : []), [placed]);
  const highlightedEdges = useMemo(() => relationHighlight(forest, selectedUid), [forest, selectedUid]);

  const nodeByUid = useMemo(() => {
    const map = new Map<number, InviteForestNode>();
    if (forest) for (const n of forest.nodes) map.set(n.uid, n);
    return map;
  }, [forest]);

  const selected = selectedUid && nodeByUid.get(selectedUid) ? nodeByUid.get(selectedUid)! : null;
  const selectedPosition = selectedUid && placed ? placed.positions.get(selectedUid) : null;

  const handleDetach = async () => {
    if (!selected) return;
    const ok = await confirm({
      title: "把该用户从上级断开？",
      description: "断开后他将成为新树根；下级关系不变。",
      tone: "warning",
      confirmLabel: "断开",
    });
    if (!ok) return;
    const res = await api.adminDetachInviteUser(selected.uid).catch((err) => ({
      success: false,
      message: err instanceof Error ? err.message : "请求异常",
    }));
    if (res.success) {
      toast({ title: "已断开上级关系" });
      await reload();
    } else {
      toast({ title: "操作失败", description: res.message, variant: "destructive" });
    }
  };

  const handleCascadeToggle = async (enable: boolean) => {
    if (!selected) return;
    const action = enable ? "启用" : "禁用";
    const cascadeRaw = window.prompt(
      `请输入级联${action}层级：\n  1 = 仅本人（默认）\n  N = 本人 + 下 N-1 层\n  0 = 整棵子树（不限层级）`,
      "1",
    );
    if (cascadeRaw === null) return;
    const parsed = parseInt(cascadeRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast({ title: "请输入 ≥ 0 的整数", variant: "destructive" });
      return;
    }
    const ok = await confirm({
      title: parsed === 0 ? `整棵子树都${action}？` : `级联${action} ${parsed} 层？`,
      description:
        parsed === 1
          ? `仅${action}本用户，下级账号不受影响。`
          : parsed === 0
            ? `沿邀请关系递归${action}该用户与全部后代账号。`
            : `${action}该用户与向下 ${parsed - 1} 层的所有下级账号。`,
      tone: enable ? "warning" : "danger",
      confirmLabel: `确认${action}`,
    });
    if (!ok) return;
    const res = await api.toggleUserActive(selected.uid, {
      enable,
      cascadeDepth: parsed,
    }).catch((err) => ({
      success: false,
      message: err instanceof Error ? err.message : "请求异常",
      data: null,
    }));
    if (res.success) {
      const affected = res.data?.affected?.length ?? 0;
      const skipped = res.data?.skipped?.length ?? 0;
      toast({
        title: `${action}完成`,
        description: `成功 ${affected}，跳过 ${skipped}`,
        variant: "success",
      });
      await reload();
    } else {
      toast({ title: "操作失败", description: res.message, variant: "destructive" });
    }
  };

  const handleCascadeDelete = async () => {
    if (!selected) return;
    const cascadeDepth = window.prompt(
      "请输入级联删除层级：\n  1 = 仅本人（默认）\n  2 = 本人 + 直接下级\n  N = 本人 + 下 N-1 层\n  0 = 整棵子树（不限层级）",
      "1",
    );
    if (cascadeDepth === null) return;
    const parsed = parseInt(cascadeDepth, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast({ title: "请输入 ≥ 0 的整数", variant: "destructive" });
      return;
    }
    const ok = await confirm({
      title: parsed === 0 ? "整棵子树都删？" : `级联删除 ${parsed} 层？`,
      description:
        parsed === 1
          ? "仅删除本用户，子节点晋升为新树根。"
          : parsed === 0
            ? "将一并删除该用户与其全部后代的本地账号 + Emby 账号。"
            : `将一并删除该用户与其向下 ${parsed - 1} 层的所有下级（本地 + Emby）。`,
      tone: "danger",
      confirmLabel: "确认删除",
    });
    if (!ok) return;
    const res = await api.deleteUserScoped(selected.uid, {
      mode: "with_emby",
      cascadeDepth: parsed,
    }).catch((err) => ({
      success: false,
      message: err instanceof Error ? err.message : "请求异常",
      data: null,
    }));
    if (res.success) {
      toast({ title: "级联删除完成" });
      setSelectedUid(null);
      await reload();
    } else {
      toast({ title: "操作失败", description: res.message, variant: "destructive" });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Network className="h-5 w-5" />
            邀请森林
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            管理员视角的整棵邀请关系。点击任意节点查看用户详情、断开/级联删除。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setScale((s) => Math.max(0.4, s - 0.1))}>
            −
          </Button>
          <span className="text-xs tabular-nums w-12 text-center">{Math.round(scale * 100)}%</span>
          <Button variant="outline" size="sm" onClick={() => setScale((s) => Math.min(2, s + 0.1))}>
            ＋
          </Button>
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>
      </div>

      {forest && (
        <div className="grid gap-3 sm:grid-cols-4">
          <Card><CardContent className="p-4">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">节点</p>
            <p className="text-2xl font-bold">{forest.nodes.length}</p>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">树根</p>
            <p className="text-2xl font-bold">{forest.roots.length}</p>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">最大深度</p>
            <p className="text-2xl font-bold">{forest.max_depth}</p>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">配置上限</p>
            <p className="text-2xl font-bold">{forest.config.max_depth}</p>
          </CardContent></Card>
        </div>
      )}

      {error ? (
        <Card className="border-destructive/40">
          <CardContent className="p-4 text-sm text-destructive flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </CardContent>
        </Card>
      ) : loading && !forest ? (
        <div className="flex h-60 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !forest || forest.nodes.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="p-10 text-center space-y-2">
            <GitBranch className="h-10 w-10 mx-auto text-muted-foreground" />
            <p className="font-medium">暂无邀请关系</p>
            <p className="text-xs text-muted-foreground">用户启用邀请系统后会自动出现在这里。</p>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden border-slate-800/70 bg-slate-950 text-slate-100 shadow-2xl shadow-sky-950/20">
          <CardContent className="p-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950 px-4 py-3">
              <div>
                <p className="text-sm font-semibold tracking-wide text-slate-100">Constellation Map</p>
                <p className="text-[11px] text-slate-400">根节点是恒星，层级像轨道向外扩散；灰色节点代表禁用或未绑定状态。</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300">
                <span className="rounded-full border border-amber-300/30 bg-amber-400/10 px-2 py-1 text-amber-200">管理员</span>
                <span className="rounded-full border border-cyan-300/30 bg-cyan-400/10 px-2 py-1 text-cyan-200">白名单</span>
                <span className="rounded-full border border-slate-500/30 bg-slate-700/40 px-2 py-1 text-slate-300">禁用/未绑定</span>
              </div>
            </div>
            <div
              ref={containerRef}
              className="overflow-auto bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.22),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(168,85,247,0.18),transparent_28%),linear-gradient(180deg,#020617,#0f172a)]"
              style={{ maxHeight: "70vh" }}
            >
              <div
                style={{
                  width: placed!.width * scale,
                  height: placed!.height * scale,
                  position: "relative",
                }}
              >
                <svg
                  viewBox={`0 0 ${placed!.width} ${placed!.height}`}
                  width={placed!.width * scale}
                  height={placed!.height * scale}
                  className="block select-none text-slate-100"
                >
                  <defs>
                    <radialGradient id="invite-node-glow" cx="50%" cy="45%" r="70%">
                      <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
                      <stop offset="42%" stopColor="#7dd3fc" stopOpacity="0.45" />
                      <stop offset="100%" stopColor="#0f172a" stopOpacity="0" />
                    </radialGradient>
                    <filter id="invite-soft-glow" x="-80%" y="-80%" width="260%" height="260%">
                      <feGaussianBlur stdDeviation="5" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                    <linearGradient id="invite-edge-gradient" x1="0" x2="1" y1="0" y2="1">
                      <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.2" />
                      <stop offset="50%" stopColor="#a78bfa" stopOpacity="0.65" />
                      <stop offset="100%" stopColor="#34d399" stopOpacity="0.2" />
                    </linearGradient>
                  </defs>
                  <rect x={0} y={0} width={placed!.width} height={placed!.height} fill="transparent" />
                  {starfield.map((star, index) => (
                    <circle key={`star-${index}`} cx={star.x} cy={star.y} r={star.r} fill="#e0f2fe" opacity={star.o} />
                  ))}
                  {placed!.systems.map((system) => (
                    <g key={`system-${system.rootUid}`}>
                      <circle cx={system.x} cy={system.y} r={system.radius + 28} fill="url(#invite-node-glow)" opacity={0.08} />
                      {Array.from({ length: Math.max(1, system.depth - 1) }, (_, index) => {
                        const ring = 74 * (index + 1);
                        if (ring > system.radius + 8) return null;
                        return (
                          <circle
                            key={`orbit-${system.rootUid}-${index}`}
                            cx={system.x}
                            cy={system.y}
                            r={ring}
                            fill="none"
                            stroke="#94a3b8"
                            strokeOpacity={0.12}
                            strokeWidth={1}
                            strokeDasharray="4 10"
                          />
                        );
                      })}
                      <text x={system.x} y={system.y + system.radius + 46} textAnchor="middle" fontSize={11} fill="#94a3b8">
                        ROOT #{system.rootUid} · {system.count} nodes · depth {system.depth}
                      </text>
                    </g>
                  ))}
                  {/* 边 */}
                  {forest.edges.map((e) => {
                    const p = placed!.positions.get(e.parent);
                    const c = placed!.positions.get(e.child);
                    if (!p || !c) return null;
                    const edgeKey = `${e.parent}-${e.child}`;
                    const isHighlighted = highlightedEdges.has(edgeKey);
                    return (
                      <path
                        key={edgeKey}
                        d={edgePath(p, c)}
                        fill="none"
                        stroke={isHighlighted ? "#f8fafc" : "url(#invite-edge-gradient)"}
                        strokeOpacity={isHighlighted ? 0.9 : 0.34}
                        strokeWidth={isHighlighted ? 2.8 : 1.35}
                        strokeLinecap="round"
                      />
                    );
                  })}
                  {selectedPosition && (
                    <circle
                      cx={selectedPosition.x}
                      cy={selectedPosition.y}
                      r={44}
                      fill="none"
                      stroke="#f8fafc"
                      strokeOpacity={0.45}
                      strokeWidth={1.5}
                      strokeDasharray="6 8"
                    />
                  )}
                  {/* 节点 */}
                  {forest.nodes.map((n) => {
                    const pos = placed!.positions.get(n.uid);
                    if (!pos) return null;
                    const isSelected = selectedUid === n.uid;
                    const color = nodeColor(n, pos.depth);
                    const r = nodeRadius(n, pos.depth);
                    return (
                      <g
                        key={n.uid}
                        transform={`translate(${pos.x}, ${pos.y})`}
                        style={{ cursor: "pointer" }}
                        onClick={() => setSelectedUid(n.uid)}
                      >
                        <circle
                          r={r + 14}
                          fill={color}
                          opacity={isSelected ? 0.28 : pos.depth === 1 ? 0.18 : 0.1}
                          filter="url(#invite-soft-glow)"
                        />
                        <circle r={r + 6} fill="none" stroke={color} strokeOpacity={0.25} strokeWidth={1} />
                        <circle
                          r={r}
                          fill={color}
                          opacity={n.active ? 0.98 : 0.55}
                          stroke={isSelected ? "#f8fafc" : n.emby_id ? "#e0f2fe" : "#64748b"}
                          strokeWidth={isSelected ? 2.4 : 1.1}
                          filter={n.active ? "url(#invite-soft-glow)" : undefined}
                        />
                        {n.role === 0 && <path d={`M -6 ${-r - 5} L 0 ${-r - 13} L 6 ${-r - 5} Z`} fill="#fbbf24" opacity={0.95} />}
                        {!n.emby_id && <circle r={r + 2} fill="none" stroke="#cbd5e1" strokeOpacity={0.55} strokeDasharray="2 3" />}
                        <text
                          textAnchor="middle"
                          y={r + 14}
                          fontSize={pos.depth === 1 ? 12 : 10.5}
                          fontFamily="ui-sans-serif, system-ui"
                          fill="#e2e8f0"
                          opacity={n.active ? 0.95 : 0.58}
                          paintOrder="stroke"
                          stroke="#020617"
                          strokeWidth={3}
                        >
                          {n.username}
                        </text>
                        {pos.depth === 1 && (
                          <text
                            textAnchor="middle"
                            y={-r - 6}
                            fontSize={9}
                            fontWeight={700}
                            fill="#fde68a"
                            letterSpacing={1.5}
                          >
                            STAR
                          </text>
                        )}
                        <title>{`${n.username} · UID ${n.uid} · L${pos.depth} · ${n.active ? "启用" : "禁用"}`}</title>
                      </g>
                    );
                  })}
                </svg>
              </div>
            </div>
            <div className="border-t border-slate-800/80 bg-slate-950/95 px-4 py-3 flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
              <span>颜色对应层级：</span>
              {DEPTH_COLOR_LIGHT.slice(0, Math.max(1, forest.max_depth)).map((c, idx) => (
                <span key={c} className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} />
                  L{idx + 1}
                </span>
              ))}
              <span className="ml-auto">点击节点查看详情；选中后高亮祖先链和整棵子树</span>
            </div>
          </CardContent>
        </Card>
      )}

      {selected && (
        <Sheet onClose={() => setSelectedUid(null)}>
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold flex items-center gap-2">
                  <Crown className="h-4 w-4 text-primary" />
                  {selected.username}
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">UID #{selected.uid}</p>
              </div>
              <SheetClose />
            </div>
            <div className="flex flex-wrap gap-2 text-[11px]">
              <Badge variant={selected.active ? "success" : "secondary"}>
                {selected.active ? "启用" : "禁用"}
              </Badge>
              <Badge variant={selected.emby_id ? "outline" : "secondary"}>
                {selected.emby_id ? "已绑 Emby" : "未绑 Emby"}
              </Badge>
              {selected.is_root && <Badge>树根</Badge>}
              {selected.telegram_id && (
                <Badge variant="outline">TG {selected.telegram_id}</Badge>
              )}
            </div>
            <dl className="space-y-1 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">角色</dt>
                <dd>{selected.role === 0 ? "管理员" : selected.role === 2 ? "白名单" : "普通用户"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">注册时间</dt>
                <dd>
                  {selected.register_time
                    ? new Date(selected.register_time * 1000).toLocaleString("zh-CN")
                    : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">到期</dt>
                <dd>
                  {!selected.expired_at || selected.expired_at <= 0 || selected.expired_at >= 253402214400
                    ? "永久"
                    : new Date(selected.expired_at * 1000).toLocaleString("zh-CN")}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">所属根</dt>
                <dd>{forest ? findRoot(forest, selected.uid) : "—"}</dd>
              </div>
            </dl>
            <div className="grid gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={handleDetach} disabled={selected.is_root}>
                <Ban className="mr-2 h-4 w-4" />
                {selected.is_root ? "已是树根" : "断开上级"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleCascadeToggle(false)}>
                <Ban className="mr-2 h-4 w-4" />
                级联禁用（自定义层级）
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleCascadeToggle(true)}>
                <ShieldCheck className="mr-2 h-4 w-4" />
                级联启用（自定义层级）
              </Button>
              <Button variant="destructive" size="sm" onClick={handleCascadeDelete}>
                <Trash2 className="mr-2 h-4 w-4" />
                级联删除（自定义层级）
              </Button>
            </div>
          </div>
        </Sheet>
      )}
    </motion.div>
  );
}
