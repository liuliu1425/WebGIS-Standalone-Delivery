import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getApiStorageScope } from "@/services/_http";
import {
  setActiveStorageUserId,
  writeScopedItem,
} from "@/services/user-local-isolation";
import {
  WorkspaceConflictApiError,
  type RemoteWorkspaceState,
} from "@/services/workspace-api";
import {
  loadWorkspaceSnapshot,
  loadDismissedLayers,
  saveWorkspaceSnapshot,
  rememberDismissedLayer,
  forgetDismissedLayer,
  WORKSPACE_SCHEMA_VERSION,
  type WorkspaceSnapshot,
} from "@/stores/layers/workspace-persist";
import {
  resetWorkspaceSyncState,
  scheduleWorkspaceSyncPush,
  syncWorkspaceOnBoot,
  workspaceSyncStatus,
} from "@/stores/layers/workspace-sync";
import {
  toRemotePayload,
  type ScopedWorkspaceBundle,
} from "@/stores/layers/workspace-remote-payload";

const fetchWorkspaceMock = vi.fn();
const pushWorkspaceMock = vi.fn();
const reloadMock = vi.fn();

vi.mock("@/services/workspace-api", () => ({
  fetchWorkspace: (...args: unknown[]) => fetchWorkspaceMock(...(args as [])),
  pushWorkspace: (...args: unknown[]) => pushWorkspaceMock(...(args as [])),
  WorkspaceConflictApiError: class WorkspaceConflictApiError extends Error {
    readonly serverRevision: number;
    constructor(message: string, serverRevision: number) {
      super(message);
      this.serverRevision = serverRevision;
    }
  },
}));

let authUserMock: { id: number; username: string; role: string } | null = null;

vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ user: authUserMock }),
}));

const MARKER_KEY = "geo:workspace-sync-user:v1";
const TEST_ORIGIN = "http://test.local";

function syncMarker(username: string): string {
  return `${username}|${getApiStorageScope()}`;
}

function mockBrowserStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", {
    localStorage: storage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    location: { reload: reloadMock, origin: TEST_ORIGIN },
  });
  return storage;
}

function snapshot(
  savedAt: string,
  tag = "koppen",
  apiScope = TEST_ORIGIN,
  schemaVersion: number = WORKSPACE_SCHEMA_VERSION,
): WorkspaceSnapshot {
  return {
    version: 1,
    schemaVersion,
    savedAt,
    apiScope,
    layers: [],
    catalogLayers: [
      {
        instanceId: `inst-${tag}`,
        catalogId: tag,
        visible: true,
        opacity: 1,
        order: 0,
      },
    ],
    vectorLayers: [],
    groups: [],
  };
}

function scopeBundle(
  savedAt: string,
  tag = "koppen",
  apiScope = TEST_ORIGIN,
  schemaVersion: number = WORKSPACE_SCHEMA_VERSION,
): ScopedWorkspaceBundle {
  return {
    snapshot: snapshot(savedAt, tag, apiScope, schemaVersion),
    dismissed: {
      overlayLayerIds: [],
      catalogIds: [],
      runIds: [],
      vectorBackendLayerIds: [],
    },
  };
}

function remoteState(
  revision: number,
  scopes: Record<string, ScopedWorkspaceBundle> | null,
): RemoteWorkspaceState {
  return {
    revision,
    updated_at: "2026-08-17T00:00:00Z",
    payload: scopes ? toRemotePayload({ version: 2, scopes }) : null,
  };
}

describe("workspace-sync 跨设备同步引擎", () => {
  let store: {
    getItem: (k: string) => string | null;
    setItem: (k: string, v: string) => void;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    fetchWorkspaceMock.mockReset();
    pushWorkspaceMock.mockReset();
    reloadMock.mockReset();
    authUserMock = null;
    setActiveStorageUserId(null);
    store = mockBrowserStorage();
  });

  afterEach(() => {
    resetWorkspaceSyncState();
    setActiveStorageUserId(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("未登录 / demo 账号：同步停用且不发起任何请求", async () => {
    authUserMock = null;
    await syncWorkspaceOnBoot();
    expect(workspaceSyncStatus.value).toBe("disabled");
    expect(fetchWorkspaceMock).not.toHaveBeenCalled();

    authUserMock = { id: 3, username: "guest", role: "demo" };
    await syncWorkspaceOnBoot();
    expect(workspaceSyncStatus.value).toBe("disabled");
    expect(fetchWorkspaceMock).not.toHaveBeenCalled();
  });

  it("同账号且远端当前 scope 较新：接管远端快照", async () => {
    authUserMock = { id: 1, username: "alice", role: "standard" };
    setActiveStorageUserId(1);
    writeScopedItem(MARKER_KEY, syncMarker("alice"));
    saveWorkspaceSnapshot(snapshot("2026-08-10T00:00:00Z", "old"));
    const remoteDismissed = {
      overlayLayerIds: ["ov-1"],
      catalogIds: ["cat-1"],
      runIds: [],
      vectorBackendLayerIds: [],
    };
    fetchWorkspaceMock.mockResolvedValue(
      remoteState(5, {
        [TEST_ORIGIN]: {
          snapshot: snapshot("2026-08-16T00:00:00Z", "new"),
          dismissed: remoteDismissed,
        },
      }),
    );

    await syncWorkspaceOnBoot();

    expect(pushWorkspaceMock).not.toHaveBeenCalled();
    const local = loadWorkspaceSnapshot();
    expect(local?.catalogLayers?.[0]?.catalogId).toBe("new");
    expect(loadDismissedLayers().overlayLayerIds).toEqual(["ov-1"]);
  });

  it("出厂配置版本升级：本地旧快照作废，远端旧快照也不被采纳", async () => {
    authUserMock = { id: 1, username: "alice", role: "standard" };
    setActiveStorageUserId(1);
    writeScopedItem(MARKER_KEY, syncMarker("alice"));
    const stale = WORKSPACE_SCHEMA_VERSION - 1;
    saveWorkspaceSnapshot(
      snapshot("2026-08-16T00:00:00Z", "stale-local", TEST_ORIGIN, stale),
    );
    // 远端 dismissed 带可识别标记：采纳成功才会被写进本地登记表，
    // 用它能区分「拒绝采纳」与「采纳后再自查过期」这两种情况。
    fetchWorkspaceMock.mockResolvedValue(
      remoteState(5, {
        [TEST_ORIGIN]: {
          snapshot: snapshot(
            "2026-08-17T00:00:00Z",
            "stale-remote",
            TEST_ORIGIN,
            stale,
          ),
          dismissed: {
            overlayLayerIds: ["stale-ov"],
            catalogIds: [],
            runIds: [],
            vectorBackendLayerIds: [],
          },
        },
      }),
    );

    await syncWorkspaceOnBoot();

    // 本地旧快照被清掉，远端旧快照（savedAt 更新）也不算「较新」⇒ 保持空，
    // 交回 ensureDefaultLayers 按当前出厂默认重建，避免旧布局被拉回来。
    expect(loadWorkspaceSnapshot()).toBeNull();
    expect(loadDismissedLayers().overlayLayerIds).toEqual([]);
    expect(pushWorkspaceMock).not.toHaveBeenCalled();
  });

  it("同账号且本地较新：推送 v2 分桶快照", async () => {
    authUserMock = { id: 1, username: "alice", role: "standard" };
    setActiveStorageUserId(1);
    writeScopedItem(MARKER_KEY, syncMarker("alice"));
    saveWorkspaceSnapshot(snapshot("2026-08-16T00:00:00Z", "local-new"));
    fetchWorkspaceMock.mockResolvedValue(
      remoteState(3, {
        [TEST_ORIGIN]: scopeBundle("2026-08-01T00:00:00Z", "remote-old"),
      }),
    );
    pushWorkspaceMock.mockResolvedValue({
      revision: 4,
      updated_at: "2026-08-17T01:00:00Z",
    });

    await syncWorkspaceOnBoot();

    expect(pushWorkspaceMock).toHaveBeenCalledTimes(1);
    const [payload, baseRevision] = pushWorkspaceMock.mock.calls[0];
    expect(baseRevision).toBe(3);
    expect(payload.version).toBe(2);
    expect(
      payload.scopes[TEST_ORIGIN].snapshot.catalogLayers[0].catalogId,
    ).toBe("local-new");
    expect(workspaceSyncStatus.value).toBe("idle");
  });

  it("账号切换且远端当前 scope 为空：清空本地工作区", async () => {
    authUserMock = { id: 2, username: "bob", role: "standard" };
    setActiveStorageUserId(2);
    writeScopedItem(MARKER_KEY, syncMarker("alice"));
    saveWorkspaceSnapshot(snapshot("2026-08-16T00:00:00Z", "alice-data"));
    fetchWorkspaceMock.mockResolvedValue(remoteState(0, null));

    await syncWorkspaceOnBoot();

    expect(pushWorkspaceMock).not.toHaveBeenCalled();
    expect(loadWorkspaceSnapshot()).toBeNull();
    expect(loadDismissedLayers().overlayLayerIds).toEqual([]);
  });

  it("API 入口切换：不采纳其它 scope 的快照，保留本机 localStorage", async () => {
    authUserMock = { id: 1, username: "alice", role: "standard" };
    setActiveStorageUserId(1);
    writeScopedItem(
      MARKER_KEY,
      syncMarker("alice").replace(TEST_ORIGIN, "http://localhost:5175"),
    );
    saveWorkspaceSnapshot(snapshot("2026-08-16T00:00:00Z", "local-only"));
    const otherScopeSnap: WorkspaceSnapshot = {
      ...snapshot("2026-08-20T00:00:00Z", "remote-from-lan"),
      apiScope: "http://localhost:5175",
      groups: [
        {
          groupId: "g1",
          runId: "run-other-env",
          title: "ω",
          status: "computing",
          memberInstanceIds: ["inst-remote"],
          dissolvable: false,
          sourceLayerId: "method-x",
        },
      ],
    };
    fetchWorkspaceMock.mockResolvedValue(
      remoteState(7, {
        "http://localhost:5175": {
          snapshot: otherScopeSnap,
          dismissed: {
            overlayLayerIds: [],
            catalogIds: [],
            runIds: [],
            vectorBackendLayerIds: [],
          },
        },
      }),
    );

    await syncWorkspaceOnBoot();

    expect(pushWorkspaceMock).not.toHaveBeenCalled();
    const local = loadWorkspaceSnapshot();
    expect(local?.catalogLayers?.[0]?.catalogId).toBe("local-only");
    expect(local?.groups).toEqual([]);
  });

  it("API 入口切换：采纳当前 scope 分桶（若较新）", async () => {
    authUserMock = { id: 1, username: "alice", role: "standard" };
    setActiveStorageUserId(1);
    writeScopedItem(
      MARKER_KEY,
      syncMarker("alice").replace(TEST_ORIGIN, "http://localhost:5175"),
    );
    saveWorkspaceSnapshot(snapshot("2026-08-10T00:00:00Z", "stale-local"));
    fetchWorkspaceMock.mockResolvedValue(
      remoteState(2, {
        [TEST_ORIGIN]: scopeBundle("2026-08-18T00:00:00Z", "public-new"),
      }),
    );

    await syncWorkspaceOnBoot();

    const local = loadWorkspaceSnapshot();
    expect(local?.catalogLayers?.[0]?.catalogId).toBe("public-new");
  });

  it("本地变更防抖推送：落盘后推送 v2 合并快照", async () => {
    authUserMock = { id: 1, username: "alice", role: "standard" };
    setActiveStorageUserId(1);
    writeScopedItem(MARKER_KEY, syncMarker("alice"));
    fetchWorkspaceMock.mockResolvedValue(remoteState(2, null));
    await syncWorkspaceOnBoot();

    pushWorkspaceMock.mockResolvedValue({
      revision: 3,
      updated_at: "2026-08-17T02:00:00Z",
    });
    saveWorkspaceSnapshot(snapshot("2026-08-17T02:30:00Z", "edited"));
    scheduleWorkspaceSyncPush();
    await vi.advanceTimersByTimeAsync(1500);

    expect(pushWorkspaceMock).toHaveBeenCalledTimes(1);
    const [payload, baseRevision] = pushWorkspaceMock.mock.calls[0];
    expect(baseRevision).toBe(2);
    expect(payload.version).toBe(2);
    expect(
      payload.scopes[TEST_ORIGIN].snapshot.catalogLayers[0].catalogId,
    ).toBe("edited");
  });

  it("推送冲突且远端当前 scope 较新：停止旧推送但不刷新或覆盖当前页面", async () => {
    authUserMock = { id: 1, username: "alice", role: "standard" };
    setActiveStorageUserId(1);
    writeScopedItem(MARKER_KEY, syncMarker("alice"));
    fetchWorkspaceMock.mockResolvedValueOnce(remoteState(2, null));
    await syncWorkspaceOnBoot();

    pushWorkspaceMock.mockRejectedValueOnce(
      new WorkspaceConflictApiError("conflict", 9),
    );
    fetchWorkspaceMock.mockResolvedValueOnce(
      remoteState(9, {
        [TEST_ORIGIN]: scopeBundle("2026-08-17T03:00:00Z", "other-device"),
      }),
    );
    saveWorkspaceSnapshot(snapshot("2026-08-17T01:00:00Z", "stale-local"));
    scheduleWorkspaceSyncPush();
    await vi.advanceTimersByTimeAsync(1500);

    expect(reloadMock).not.toHaveBeenCalled();
    expect(loadWorkspaceSnapshot()?.catalogLayers?.[0]?.catalogId).toBe(
      "stale-local",
    );
    expect(workspaceSyncStatus.value).toBe("idle");
  });

  it("异地更新连续轮询不刷新、不覆盖本地；重新进入页面仍恢复远端", async () => {
    authUserMock = { id: 1, username: "alice", role: "standard" };
    setActiveStorageUserId(1);
    writeScopedItem(MARKER_KEY, syncMarker("alice"));
    fetchWorkspaceMock.mockResolvedValueOnce(remoteState(2, {
      [TEST_ORIGIN]: scopeBundle("2026-08-17T01:00:00Z", "local"),
    }));
    await syncWorkspaceOnBoot();
    fetchWorkspaceMock.mockResolvedValue(remoteState(9, {
      [TEST_ORIGIN]: scopeBundle("2026-08-17T03:00:00Z", "other-device"),
    }));
    await vi.advanceTimersByTimeAsync(180_100);
    expect(reloadMock).not.toHaveBeenCalled();
    expect(loadWorkspaceSnapshot()?.catalogLayers?.[0]?.catalogId).toBe("local");
    expect(pushWorkspaceMock).not.toHaveBeenCalled();
    resetWorkspaceSyncState();
    await syncWorkspaceOnBoot();
    expect(loadWorkspaceSnapshot()?.catalogLayers?.[0]?.catalogId).toBe("other-device");
  });

  it("延期接收远端更新后，本地新操作仍携最新revision自动保存", async () => {
    authUserMock = { id: 1, username: "alice", role: "standard" };
    setActiveStorageUserId(1);
    writeScopedItem(MARKER_KEY, syncMarker("alice"));
    fetchWorkspaceMock.mockResolvedValueOnce(remoteState(2, {
      [TEST_ORIGIN]: scopeBundle("2026-08-17T01:00:00Z", "local"),
    }));
    await syncWorkspaceOnBoot();
    fetchWorkspaceMock.mockResolvedValue(remoteState(9, {
      [TEST_ORIGIN]: scopeBundle("2026-08-17T03:00:00Z", "other-device"),
    }));
    await vi.advanceTimersByTimeAsync(90_100);
    pushWorkspaceMock.mockResolvedValue({ revision: 10, updated_at: "2026-08-17T04:00:00Z" });
    saveWorkspaceSnapshot(snapshot("2026-08-17T04:00:00Z", "user-edit"));
    scheduleWorkspaceSyncPush();
    await vi.advanceTimersByTimeAsync(1500);
    expect(pushWorkspaceMock).toHaveBeenCalledTimes(1);
    const [payload, revision] = pushWorkspaceMock.mock.calls[0];
    expect(revision).toBe(9);
    expect(payload.scopes[TEST_ORIGIN].snapshot.catalogLayers[0].catalogId).toBe("user-edit");
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("较新的旧页面快照不能覆盖另一页面的移除记录", async () => {
    authUserMock = { id: 1, username: "alice", role: "standard" };
    setActiveStorageUserId(1);
    writeScopedItem(MARKER_KEY, syncMarker("alice"));
    const remote = scopeBundle("2026-08-17T01:00:00Z", "keep");
    remote.dismissed.catalogIds = ["aridity-cn"];
    fetchWorkspaceMock.mockResolvedValue(remoteState(9, { [TEST_ORIGIN]: remote }));
    const stale = snapshot("2026-08-17T04:00:00Z", "aridity-cn");
    stale.catalogLayers!.push(snapshot("2026-08-17T04:00:00Z", "keep").catalogLayers![0]!);
    saveWorkspaceSnapshot(stale);
    pushWorkspaceMock.mockResolvedValue({ revision: 10, updated_at: "2026-08-17T04:00:01Z" });
    await syncWorkspaceOnBoot();
    expect(loadWorkspaceSnapshot()?.catalogLayers?.map(l => l.catalogId)).toEqual(["keep"]);
    const [payload] = pushWorkspaceMock.mock.calls[0];
    expect(payload.scopes[TEST_ORIGIN].snapshot.catalogLayers.map((l: {catalogId:string}) => l.catalogId)).toEqual(["keep"]);
    expect(payload.scopes[TEST_ORIGIN].dismissed.catalogIds).toContain("aridity-cn");
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("旧远端快照回写后，本地已移除对象在重新进入时仍不会复活", async () => {
    authUserMock = { id: 1, username: "alice", role: "standard" };
    setActiveStorageUserId(1);
    writeScopedItem(MARKER_KEY, syncMarker("alice"));
    rememberDismissedLayer({ catalogId: "aridity-cn" });
    saveWorkspaceSnapshot(snapshot("2026-08-17T01:00:00Z", "keep"));
    const remote = scopeBundle("2026-08-17T04:00:00Z", "aridity-cn");
    remote.snapshot.catalogLayers!.push(snapshot("2026-08-17T04:00:00Z", "keep").catalogLayers![0]!);
    fetchWorkspaceMock.mockResolvedValue(remoteState(11, { [TEST_ORIGIN]: remote }));
    await syncWorkspaceOnBoot();
    expect(loadWorkspaceSnapshot()?.catalogLayers?.map(l => l.catalogId)).toEqual(["keep"]);
    expect(loadDismissedLayers().catalogIds).toContain("aridity-cn");
  });

  it("手动重新添加会同步撤销移除记录，随后再移除仍然生效", async () => {
    authUserMock = { id: 1, username: "alice", role: "standard" };
    setActiveStorageUserId(1);
    writeScopedItem(MARKER_KEY, syncMarker("alice"));
    rememberDismissedLayer({ catalogId: "aridity-cn" });
    const oldRemoval = structuredClone(loadDismissedLayers());
    fetchWorkspaceMock.mockResolvedValue(remoteState(12, {
      [TEST_ORIGIN]: { ...scopeBundle("2026-08-17T01:00:00Z", "keep"), dismissed: oldRemoval },
    }));
    await syncWorkspaceOnBoot();
    forgetDismissedLayer({ catalogId: "aridity-cn" });
    saveWorkspaceSnapshot(snapshot("2026-08-17T04:00:00Z", "aridity-cn"));
    pushWorkspaceMock.mockResolvedValue({ revision: 13, updated_at: "2026-08-17T04:00:01Z" });
    scheduleWorkspaceSyncPush();
    await vi.advanceTimersByTimeAsync(1500);
    const [payload] = pushWorkspaceMock.mock.calls[0];
    expect(payload.scopes[TEST_ORIGIN].dismissed.catalogIds).not.toContain("aridity-cn");
    expect(payload.scopes[TEST_ORIGIN].dismissed.operations["catalogIds:aridity-cn"].removed).toBe(false);
    expect(payload.scopes[TEST_ORIGIN].snapshot.catalogLayers[0].catalogId).toBe("aridity-cn");
    rememberDismissedLayer({ catalogId: "aridity-cn" });
    expect(loadWorkspaceSnapshot()?.catalogLayers).toEqual([]);
  });

  it("拉取失败：进入 error 状态且不抛出（不影响 hydrate 启动）", async () => {
    authUserMock = { id: 1, username: "alice", role: "standard" };
    setActiveStorageUserId(1);
    writeScopedItem(MARKER_KEY, syncMarker("alice"));
    fetchWorkspaceMock.mockRejectedValue(new Error("backend offline"));

    await expect(syncWorkspaceOnBoot()).resolves.toBeUndefined();
    expect(workspaceSyncStatus.value).toBe("error");
  });
});
