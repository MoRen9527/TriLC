using System.Diagnostics;

namespace TriLC.Tray;

/// <summary>
/// 右键菜单构建器。管理 NotifyIcon 的 ContextMenuStrip。
/// </summary>
public class MenuBuilder
{
    private readonly NotifyIcon _notifyIcon;
    private readonly DaemonChecker _checker;
    private readonly DaemonProcessManager _processMgr;

    private ToolStripMenuItem? _statusItem;
    private ToolStripMenuItem? _startStopItem;

    public MenuBuilder(
        NotifyIcon notifyIcon,
        DaemonChecker checker,
        DaemonProcessManager processMgr)
    {
        _notifyIcon = notifyIcon;
        _checker = checker;
        _processMgr = processMgr;
    }

    public ContextMenuStrip Build()
    {
        var menu = new ContextMenuStrip();

        // ① 状态指示（不可点击）
        _statusItem = new ToolStripMenuItem("TriLC 状态: ● 检测中...")
        {
            Enabled = false
        };
        menu.Items.Add(_statusItem);
        menu.Items.Add(new ToolStripSeparator());

        // ② 启动/停止
        _startStopItem = new ToolStripMenuItem("启动 TriLC");
        _startStopItem.Click += async (_, _) => await OnStartStop();
        // 如果 CLI 无法定位，禁用启动/停止菜单
        if (!_processMgr.CanStartStop)
        {
            _startStopItem.Enabled = false;
            _startStopItem.ToolTipText = "找不到 TriLC CLI，请设置环境变量 TRI_LC_CLI_PATH";
        }
        menu.Items.Add(_startStopItem);
        menu.Items.Add(new ToolStripSeparator());

        // ③ 打开会话面板
        var panelItem = new ToolStripMenuItem("打开本地会话面板");
        panelItem.Click += (_, _) =>
            Process.Start(new ProcessStartInfo
            {
                FileName = "http://127.0.0.1:8711/panel",
                UseShellExecute = true
            });
        menu.Items.Add(panelItem);
        menu.Items.Add(new ToolStripSeparator());

        // ④ 关于
        var aboutItem = new ToolStripMenuItem("关于 TriLC");
        aboutItem.Click += (_, _) =>
            MessageBox.Show(
                "TriLC Tray v1.0.0\n" +
                "TriMetaverse Local Controller\n" +
                "Windows System Tray Indicator\n\n" +
                "© 2026 TriMetaverse",
                "关于 TriLC",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        menu.Items.Add(aboutItem);

        // ⑤ 退出
        var exitItem = new ToolStripMenuItem("退出");
        exitItem.Click += (_, _) => Application.Exit();
        menu.Items.Add(exitItem);

        return menu;
    }

    /// <summary>
    /// 根据 daemon 状态刷新菜单文本。
    /// </summary>
    public void RefreshState(DaemonState state)
    {
        if (_statusItem != null)
        {
            _statusItem.Text = state switch
            {
                DaemonState.Running => "TriLC 状态: ● 运行中",
                DaemonState.Stopped => "TriLC 状态: ● 已停止",
                DaemonState.Unknown => "TriLC 状态: ● 检测中...",
                _                   => "TriLC 状态: ● 未知"
            };
        }

        if (_startStopItem != null)
        {
            if (!_processMgr.CanStartStop)
            {
                _startStopItem.Text = "启动/停止不可用";
                _startStopItem.Enabled = false;
                _startStopItem.ToolTipText = "找不到 TriLC CLI，请设置环境变量 TRI_LC_CLI_PATH";
            }
            else if (state == DaemonState.Running)
            {
                _startStopItem.Text = "停止 TriLC";
                _startStopItem.Enabled = true;
                _startStopItem.ToolTipText = null;
            }
            else
            {
                _startStopItem.Text = "启动 TriLC";
                _startStopItem.Enabled = true;
                _startStopItem.ToolTipText = null;
            }
        }
    }

    private async Task OnStartStop()
    {
        if (_checker.CurrentState == DaemonState.Running)
        {
            await _processMgr.StopDaemon();
        }
        else
        {
            await _processMgr.StartDaemon();
        }
        // 下一轮 poll 自动更新图标和菜单状态
    }
}
