using System.Diagnostics;

namespace TriLC.Tray;

/// <summary>
/// 委托 triLC CLI (cli.js) 启动/停止 daemon 进程。
/// Tray 本身不承载 daemon 生命周期，只做快捷入口。
/// </summary>
public class DaemonProcessManager
{
    private readonly string? _cliPath;

    /// <summary>
    /// 构造函数。
    /// </summary>
    /// <param name="cliPath">
    /// triLC CLI 入口路径（如 "D:\TriLC\dist\cli.js"）。
    /// 若为 null 或空，CanStartStop 将为 false，菜单项将被禁用。
    /// </param>
    public DaemonProcessManager(string? cliPath)
    {
        _cliPath = cliPath;
    }

    /// <summary>
    /// 是否可以从托盘执行启动/停止操作。
    /// </summary>
    public bool CanStartStop =>
        !string.IsNullOrEmpty(_cliPath) && File.Exists(_cliPath);

    public async Task StartDaemon()
    {
        if (!CanStartStop) return;
        await RunCliCommand("start");
    }

    public async Task StopDaemon()
    {
        if (!CanStartStop) return;
        await RunCliCommand("stop");
    }

    private async Task RunCliCommand(string command)
    {
        if (string.IsNullOrEmpty(_cliPath)) return;

        var psi = new ProcessStartInfo
        {
            FileName = "node",
            Arguments = $"\"{_cliPath}\" {command}",
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };

        using var process = Process.Start(psi);
        if (process == null) return;

        // 不等待完成（避免阻塞 UI），但设置一个合理超时
        // Phase 1：fire-and-forget，结果通过下轮 healthz 验证
        await Task.WhenAny(
            process.WaitForExitAsync(),
            Task.Delay(TimeSpan.FromSeconds(15))
        );

        if (!process.HasExited)
        {
            // 超时：进程可能卡住，不 kill（避免损坏 daemon 状态）
        }
    }

    /// <summary>
    /// 自动定位 CLI 路径（fallback 链）。
    /// </summary>
    public static string? FindCliPath()
    {
        // 1. 环境变量 TRI_LC_CLI_PATH
        var envPath = Environment.GetEnvironmentVariable("TRI_LC_CLI_PATH");
        if (!string.IsNullOrEmpty(envPath) && File.Exists(envPath))
            return envPath;

        // 2. 与 daemon 同级的默认路径
        var trayDir = AppDomain.CurrentDomain.BaseDirectory;
        var siblingPath = Path.Combine(trayDir, "..", "triLC", "dist", "cli.js");
        if (File.Exists(siblingPath))
            return Path.GetFullPath(siblingPath);

        // 3. 程序目录下的 trilc 子目录
        var localPath = Path.Combine(trayDir, "triLC", "dist", "cli.js");
        if (File.Exists(localPath))
            return Path.GetFullPath(localPath);

        return null; // 无法定位 → "启动"菜单项灰掉
    }
}
