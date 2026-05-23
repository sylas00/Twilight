"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Ban,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { api, type InviteForest, type InviteForestNode } from "@/lib/api";

interface TreeRow {
  node: InviteForestNode;
  depth: number;
  root: number;
  childCount: number;
}

interface DepthPromptState {
  title: string;
  description: string;
  value: string;
  confirmLabel: string;
  resolve: (value: string | null) => void;
}

function buildMaps(forest: InviteForest) {
  const nodeByUid = new Map<number, InviteForestNode>();
  const children = new Map<number, number[]>();
  const parent = new Map<number, number>();
  for (const node of forest.nodes) nodeByUid.set(node.uid, node);
  for (const edge of forest.edges) {
    if (!children.has(edge.parent)) children.set(edge.parent, []);
    children.get(edge.parent)!.push(edge.child);
    parent.set(edge.child, edge.parent);
  }
  for (const ids of children.values()) ids.sort((a, b) => a - b);
  return { nodeByUid, children, parent };
}

function findRoot(uid: number, parent: Map<number, number>): number {
  let current = uid;
  const seen = new Set<number>();
  while (parent.has(current) && !seen.has(current)) {
    seen.add(current);
    current = parent.get(current)!;
  }
  return current;
}

function subtreeSize(uid: number, children: Map<number, number[]>): number {
  let total = 0;
  const stack = [...(children.get(uid) || [])];
  while (stack.length) {
    const current = stack.pop()!;
    total += 1;
    stack.push(...(children.get(current) || []));
  }
  return total;
}

function roleLabel(role: number): string {
  if (role === 0) return "Admin";
  if (role === 2) return "Whitelist";
  return "User";
}

function formatUnix(seconds?: number | null): string {
  if (!seconds || seconds <= 0 || seconds >= 253402214400) return "Permanent";
  return new Date(seconds * 1000).toLocaleString("zh-CN");
}

export default function AdminInviteTreePage() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [forest, setForest] = useState<InviteForest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [rootFilter, setRootFilter] = useState<number | "all">("all");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [depthPrompt, setDepthPrompt] = useState<DepthPromptState | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.adminGetInviteTree();
      if (res.success && res.data) {
        setForest(res.data);
      } else {
        throw new Error(res.message || "Load failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const maps = useMemo(() => (forest ? buildMaps(forest) : null), [forest]);
  const rootOptions = useMemo(() => {
    if (!forest || !maps) return [];
    return forest.roots
      .filter((uid) => maps.nodeByUid.has(uid))
      .sort((a, b) => a - b)
      .map((uid) => ({ uid, node: maps.nodeByUid.get(uid)! }));
  }, [forest, maps]);

  const includedBySearch = useMemo(() => {
    const set = new Set<number>();
    const q = deferredQuery.trim().toLowerCase();
    if (!q || !forest || !maps) return set;
    for (const node of forest.nodes) {
      const matched =
        node.username.toLowerCase().includes(q) ||
        String(node.uid).includes(q) ||
        String(node.telegram_id || "").includes(q);
      if (!matched) continue;
      let current: number | undefined = node.uid;
      while (current && !set.has(current)) {
        set.add(current);
        current = maps.parent.get(current);
      }
    }
    return set;
  }, [deferredQuery, forest, maps]);

  const rows = useMemo(() => {
    if (!forest || !maps) return [];
    const q = deferredQuery.trim();
    const out: TreeRow[] = [];
    const roots = rootFilter === "all" ? forest.roots : [rootFilter];
    for (const root of roots) {
      const stack: Array<{ uid: number; depth: number }> = [{ uid: root, depth: 0 }];
      while (stack.length) {
        const item = stack.pop()!;
        const node = maps.nodeByUid.get(item.uid);
        if (!node) continue;
        if (!q || includedBySearch.has(item.uid)) {
          out.push({
            node,
            depth: item.depth,
            root: findRoot(item.uid, maps.parent),
            childCount: maps.children.get(item.uid)?.length || 0,
          });
        }
        if (!collapsed.has(item.uid)) {
          const childIds = [...(maps.children.get(item.uid) || [])].reverse();
          for (const child of childIds) stack.push({ uid: child, depth: item.depth + 1 });
        }
      }
    }
    return out;
  }, [collapsed, deferredQuery, forest, includedBySearch, maps, rootFilter]);

  const selected = selectedUid && maps?.nodeByUid.get(selectedUid) ? maps.nodeByUid.get(selectedUid)! : null;

  useEffect(() => {
    if (forest && rootFilter !== "all" && !forest.roots.includes(rootFilter)) setRootFilter("all");
  }, [forest, rootFilter]);

  useEffect(() => {
    if (selectedUid && maps && !maps.nodeByUid.has(selectedUid)) setSelectedUid(null);
  }, [maps, selectedUid]);

  const requestDepth = useCallback((title: string, description: string, confirmLabel: string) => {
    return new Promise<string | null>((resolve) => {
      setDepthPrompt({ title, description, value: "1", confirmLabel, resolve });
    });
  }, []);

  const closeDepthPrompt = (value: string | null) => {
    setDepthPrompt((current) => {
      if (current) current.resolve(value);
      return null;
    });
  };

  const handleDetach = async () => {
    if (!selected) return;
    const ok = await confirm({
      title: "Detach invite parent?",
      description: "The user becomes a new root. Children remain attached to this user.",
      tone: "warning",
      confirmLabel: "Detach",
    });
    if (!ok) return;
    const res = await api.adminDetachInviteUser(selected.uid).catch((err) => ({
      success: false,
      message: err instanceof Error ? err.message : "Request failed",
    }));
    if (res.success) {
      toast({ title: "Detached" });
      await reload();
    } else {
      toast({ title: "Action failed", description: res.message, variant: "destructive" });
    }
  };

  const handleCascadeToggle = async (enable: boolean) => {
    if (!selected) return;
    const action = enable ? "enable" : "disable";
    const raw = await requestDepth(
      `Cascade ${action}`,
      "1 = selected user only, N = selected user plus N-1 levels, 0 = whole subtree.",
      `Confirm ${action}`,
    );
    if (raw === null) return;
    const depth = parseInt(raw, 10);
    if (!Number.isFinite(depth) || depth < 0) {
      toast({ title: "Depth must be a non-negative integer", variant: "destructive" });
      return;
    }
    const ok = await confirm({
      title: `Confirm cascade ${action}?`,
      description: depth === 0 ? "This applies to the whole subtree." : `This applies depth ${depth}.`,
      tone: enable ? "warning" : "danger",
      confirmLabel: `Confirm ${action}`,
    });
    if (!ok) return;
    const res = await api.toggleUserActive(selected.uid, { enable, cascadeDepth: depth }).catch((err) => ({
      success: false,
      message: err instanceof Error ? err.message : "Request failed",
      data: null,
    }));
    if (res.success) {
      toast({
        title: "Cascade updated",
        description: `Affected ${res.data?.affected?.length ?? 0}, skipped ${res.data?.skipped?.length ?? 0}`,
        variant: "success",
      });
      await reload();
    } else {
      toast({ title: "Action failed", description: res.message, variant: "destructive" });
    }
  };

  const handleCascadeDelete = async () => {
    if (!selected) return;
    const raw = await requestDepth(
      "Cascade delete",
      "1 = selected user only, N = selected user plus N-1 levels, 0 = whole subtree.",
      "Continue delete",
    );
    if (raw === null) return;
    const depth = parseInt(raw, 10);
    if (!Number.isFinite(depth) || depth < 0) {
      toast({ title: "Depth must be a non-negative integer", variant: "destructive" });
      return;
    }
    const ok = await confirm({
      title: "Confirm cascade delete?",
      description: depth === 0 ? "This deletes the whole subtree locally and in Emby." : `This deletes depth ${depth} locally and in Emby.`,
      tone: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const res = await api.deleteUserScoped(selected.uid, { mode: "with_emby", cascadeDepth: depth }).catch((err) => ({
      success: false,
      message: err instanceof Error ? err.message : "Request failed",
    }));
    if (res.success) {
      toast({ title: "Deleted", variant: "success" });
      setSelectedUid(null);
      await reload();
    } else {
      toast({ title: "Action failed", description: res.message, variant: "destructive" });
    }
  };

  const toggleCollapse = (uid: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <GitBranch className="h-5 w-5" />
            Invite Tree
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Lightweight invite relationship table with search, root filtering, and cascade operations.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Refresh
        </Button>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="grid gap-2 sm:grid-cols-[minmax(220px,1fr)_220px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search username / UID / Telegram ID" className="pl-9" />
            </div>
            <select
              value={rootFilter}
              onChange={(event) => setRootFilter(event.target.value === "all" ? "all" : Number(event.target.value))}
              className="h-10 rounded-md border bg-background px-3 text-sm"
            >
              <option value="all">All roots</option>
              {rootOptions.map(({ uid, node }) => (
                <option key={uid} value={uid}>
                  #{uid} {node.username}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{forest?.nodes.length ?? 0} users</Badge>
            <Badge variant="outline">{forest?.edges.length ?? 0} relations</Badge>
            <Badge variant="outline">{forest?.roots.length ?? 0} roots</Badge>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <Card className="border-destructive/40">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-destructive">
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
          <CardContent className="space-y-2 p-10 text-center">
            <GitBranch className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="font-medium">No invite relationships</p>
            <p className="text-xs text-muted-foreground">Invite users will appear here after invite codes are used.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-auto">
              <table className="w-full min-w-[920px] text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">User</th>
                    <th className="px-4 py-3 text-left font-medium">Role</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium">Emby</th>
                    <th className="px-4 py-3 text-left font-medium">Telegram</th>
                    <th className="px-4 py-3 text-left font-medium">Children</th>
                    <th className="px-4 py-3 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ node, depth, root, childCount }) => {
                    const descendants = maps ? subtreeSize(node.uid, maps.children) : 0;
                    const isCollapsed = collapsed.has(node.uid);
                    return (
                      <tr
                        key={node.uid}
                        className={`border-b hover:bg-muted/30 ${selectedUid === node.uid ? "bg-primary/5" : ""}`}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setSelectedUid(node.uid);
                        }}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2" style={{ paddingLeft: depth * 18 }}>
                            {childCount > 0 ? (
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => toggleCollapse(node.uid)}>
                                {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                              </Button>
                            ) : (
                              <span className="h-7 w-7" />
                            )}
                            <div className="min-w-0">
                              <button className="truncate text-left font-medium hover:underline" onClick={() => setSelectedUid(node.uid)}>
                                {node.username}
                              </button>
                              <p className="text-xs text-muted-foreground">
                                UID {node.uid} · L{depth + 1} · root {root}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">{roleLabel(node.role)}</td>
                        <td className="px-4 py-3">
                          <Badge variant={node.active ? "success" : "destructive"}>{node.active ? "Active" : "Disabled"}</Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={node.emby_id ? "outline" : "secondary"}>{node.emby_id ? "Bound" : "Unbound"}</Badge>
                        </td>
                        <td className="px-4 py-3">{node.telegram_id || "-"}</td>
                        <td className="px-4 py-3">{childCount} direct / {descendants} total</td>
                        <td className="px-4 py-3 text-right">
                          <Button variant="outline" size="sm" onClick={() => setSelectedUid(node.uid)}>
                            Details
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.length === 0 && (
              <div className="p-8 text-center text-sm text-muted-foreground">No users match the current filter.</div>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelectedUid(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{selected?.username}</DialogTitle>
            <DialogDescription>UID {selected?.uid}</DialogDescription>
          </DialogHeader>
          {selected && maps && (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-2">
                <Badge variant={selected.active ? "success" : "secondary"}>{selected.active ? "Active" : "Disabled"}</Badge>
                <Badge variant={selected.emby_id ? "outline" : "secondary"}>{selected.emby_id ? "Emby bound" : "No Emby"}</Badge>
                {selected.is_root && <Badge>Root</Badge>}
              </div>
              <dl className="space-y-2">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Role</dt>
                  <dd>{roleLabel(selected.role)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Registered</dt>
                  <dd>{formatUnix(selected.register_time)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Expires</dt>
                  <dd>{formatUnix(selected.expired_at)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Root</dt>
                  <dd>{findRoot(selected.uid, maps.parent)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Subtree</dt>
                  <dd>{subtreeSize(selected.uid, maps.children)} descendants</dd>
                </div>
              </dl>
              <div className="grid gap-2 pt-2">
                <Button variant="outline" size="sm" onClick={() => void handleDetach()} disabled={selected.is_root}>
                  <Ban className="mr-2 h-4 w-4" />
                  {selected.is_root ? "Already root" : "Detach parent"}
                </Button>
                <Button variant="outline" size="sm" onClick={() => void handleCascadeToggle(false)}>
                  <Ban className="mr-2 h-4 w-4" />
                  Cascade disable
                </Button>
                <Button variant="outline" size="sm" onClick={() => void handleCascadeToggle(true)}>
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  Cascade enable
                </Button>
                <Button variant="destructive" size="sm" onClick={() => void handleCascadeDelete()}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Cascade delete
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={depthPrompt !== null} onOpenChange={(open) => { if (!open) closeDepthPrompt(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{depthPrompt?.title}</DialogTitle>
            <DialogDescription>{depthPrompt?.description}</DialogDescription>
          </DialogHeader>
          <Input
            type="number"
            min={0}
            value={depthPrompt?.value || "1"}
            onChange={(event) => setDepthPrompt((current) => current ? { ...current, value: event.target.value } : current)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => closeDepthPrompt(null)}>Cancel</Button>
            <Button onClick={() => closeDepthPrompt(depthPrompt?.value || "1")}>{depthPrompt?.confirmLabel || "Continue"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
