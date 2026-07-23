namespace TriLC.Tray;

/// <summary>
/// Windows 桌面通知管理。
/// 使用 WinForms 内置 NotifyIcon.ShowBalloonTip()，零额外依赖。
/// </summary>
public class NotificationManager
{
    private readonly NotifyIcon _notifyIcon;
    private DaemonState _lastNotifiedState = DaemonState.Unknown;

    public NotificationManager(NotifyIcon notifyIcon)
    {
        _notifyIcon = notifyIcon;
    }

    /// <summary>
    /// 处理 daemon 状态变更，在 Running→Stopped 时弹通知。
    /// </summary>
    /// <param name="oldState">旧状态。</param>
    /// <param name="newState">新状态。</param>
    public void OnStateChanged(DaemonState oldState, DaemonState newState)
    {
        // 只有在变为 Stopped 时通知
        // 且避免同态重复通知（_lastNotifiedState 防抖）
        if (newState == DaemonState.Stopped
            && _lastNotifiedState != DaemonState.Stopped)
        {
            ShowStoppedNotification();
        }

        _lastNotifiedState = newState;
    }

    private void ShowStoppedNotification()
    {
        // 使用 NotifyIcon.ShowBalloonTip（无需额外依赖，Phase 1 选择）
        // 10 秒后自动消失
        _notifyIcon.ShowBalloonTip(
            timeout: 10000,
            tipTitle: "TriLC",
            tipText: "TriLC 已停止运行。\n右键托盘图标可尝试重新启动。",
            tipIcon: ToolTipIcon.Error);
    }

    /// <summary>
    /// 重置通知状态（例如在重新连接后）。
    /// </summary>
    public void Reset()
    {
        _lastNotifiedState = DaemonState.Unknown;
    }
}
