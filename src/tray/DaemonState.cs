namespace TriLC.Tray;

/// <summary>
/// Daemon 运行状态枚举。
/// </summary>
public enum DaemonState
{
    /// <summary>初始状态，尚未完成首次 healthz 检查。</summary>
    Unknown,
    /// <summary>Daemon 正常运行（/healthz 返回 200 OK，且 ok: true）。</summary>
    Running,
    /// <summary>Daemon 已停止或不可达（/healthz 非 200 / 超时 / 连接拒绝）。</summary>
    Stopped
}
