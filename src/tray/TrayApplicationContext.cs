using System.Diagnostics;
using System.Reflection;

namespace TriLC.Tray;

/// <summary>
/// 托盘应用上下文：NotifyIcon 创建、生命周期管理、组件组装。
/// 作为 Application.Run() 的上下文对象运行 WinForms 消息循环。
/// </summary>
public class TrayApplicationContext : ApplicationContext
{
    private readonly NotifyIcon _notifyIcon;
    private readonly DaemonChecker _checker;
    private readonly MenuBuilder _menuBuilder;
    private readonly NotificationManager _notifications;
    private readonly Icon _iconGreen;
    private readonly Icon _iconRed;
    private readonly Icon _iconGray;
    private bool _cleanedUp;

    public TrayApplicationContext()
    {
        // 加载嵌入图标
        _iconGreen = LoadIcon("tri_green.ico");
        _iconRed   = LoadIcon("tri_red.ico");
        _iconGray  = LoadIcon("tri_gray.ico");

        // 初始化 NotifyIcon
        _notifyIcon = new NotifyIcon
        {
            Icon = _iconGray,
            Visible = true,
            Text = "TriLC — 正在检测..."
        };

        // 初始化组件
        var cliPath = DaemonProcessManager.FindCliPath();
        var processMgr = new DaemonProcessManager(cliPath);
        _checker = new DaemonChecker();
        _menuBuilder = new MenuBuilder(_notifyIcon, _checker, processMgr);
        _notifications = new NotificationManager(_notifyIcon);

        // 构建右键菜单
        _notifyIcon.ContextMenuStrip = _menuBuilder.Build();

        // 左键单击 → 打开会话面板
        _notifyIcon.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left)
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "http://127.0.0.1:8711/panel",
                    UseShellExecute = true
                });
            }
        };

        // 订阅 daemon 状态变更
        _checker.StateChanged += (oldState, newState) =>
        {
            // 在 UI 线程更新托盘图标和菜单
            _notifyIcon?.BeginInvoke(() =>
            {
                if (_cleanedUp) return;
                SetTrayState(newState);
                _menuBuilder.RefreshState(newState);
                UpdateTooltip(newState);
            });

            // 通知管理（线程安全，不依赖 UI 线程）
            _notifications.OnStateChanged(oldState, newState);
        };

        // 启动 healthz 轮询
        _checker.Start();

        // 退出时清理资源
        Application.ApplicationExit += (_, _) => Cleanup();
    }

    /// <summary>
    /// 根据 daemon 状态切换托盘图标颜色。
    /// </summary>
    private void SetTrayState(DaemonState state)
    {
        _notifyIcon.Icon = state switch
        {
            DaemonState.Running => _iconGreen,
            DaemonState.Stopped => _iconRed,
            _                   => _iconGray
        };
    }

    /// <summary>
    /// 更新鼠标悬停 tooltip 文本。
    /// </summary>
    private void UpdateTooltip(DaemonState state)
    {
        _notifyIcon.Text = state switch
        {
            DaemonState.Running => "TriLC — 运行中",
            DaemonState.Stopped => "TriLC — 已停止",
            _                   => "TriLC — 正在检测..."
        };
    }

    /// <summary>
    /// 清理所有资源。退出托盘不影响 daemon 进程。
    /// </summary>
    private void Cleanup()
    {
        if (_cleanedUp) return;
        _cleanedUp = true;

        _checker.Stop();
        _checker.Dispose();
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _iconGreen?.Dispose();
        _iconRed?.Dispose();
        _iconGray?.Dispose();
    }

    /// <summary>
    /// 从嵌入资源加载图标。
    /// </summary>
    private static Icon LoadIcon(string name)
    {
        try
        {
            using var stream = Assembly.GetExecutingAssembly()
                .GetManifestResourceStream($"TriLC.Tray.Resources.{name}");
            return stream != null
                ? new Icon(stream)
                : SystemIcons.Application; // fallback
        }
        catch
        {
            return SystemIcons.Application; // fallback
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            Cleanup();
        }
        base.Dispose(disposing);
    }
}
