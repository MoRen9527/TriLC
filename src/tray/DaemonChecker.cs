using System.Net.Http;
using System.Text.Json;

namespace TriLC.Tray;

/// <summary>
/// HTTP /healthz 轮询器，消费 TriLC daemon 健康检查端点。
/// 每 5s 轮询一次，驱动托盘图标状态机。
/// </summary>
public class DaemonChecker : IDisposable
{
    private readonly HttpClient _http;
    private readonly System.Windows.Forms.Timer _timer;
    private DaemonState _currentState = DaemonState.Unknown;
    private bool _firstCheckDone;
    private bool _disposed;

    /// <summary>
    /// 状态变更事件。(oldState, newState)
    /// 注意：回调可能不在 UI 线程，消费方需自行 BeginInvoke。
    /// </summary>
    public event Action<DaemonState, DaemonState>? StateChanged;

    public DaemonChecker()
    {
        _http = new HttpClient
        {
            BaseAddress = new Uri("http://127.0.0.1:8711"),
            Timeout = TimeSpan.FromSeconds(3)
        };

        _timer = new System.Windows.Forms.Timer
        {
            Interval = 5000,
            Enabled = false
        };
        _timer.Tick += async (_, _) => await CheckHealth();
    }

    public DaemonState CurrentState => _currentState;

    /// <summary>
    /// 是否已完成首次检查（用于判断初始 Unknown 是否为"尚未检测"）。
    /// </summary>
    public bool IsFirstCheckDone => _firstCheckDone;

    /// <summary>
    /// 启动轮询。立即执行一次检查（不等 5s 首轮延迟）。
    /// </summary>
    public void Start()
    {
        if (_disposed) return;
        _timer.Start();
        // 启动时立即执行一次检查（通过 Task.Run 避免阻塞调用方）
        _ = Task.Run(async () => await CheckHealth());
    }

    /// <summary>
    /// 停止轮询。
    /// </summary>
    public void Stop()
    {
        _timer.Stop();
    }

    private async Task CheckHealth()
    {
        if (_disposed) return;

        var oldState = _currentState;
        DaemonState newState;

        try
        {
            var response = await _http.GetAsync("/healthz");
            if (response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync();
                using var doc = JsonDocument.Parse(body);
                var ok = doc.RootElement.TryGetProperty("ok", out var okProp)
                    && okProp.GetBoolean();
                newState = ok ? DaemonState.Running : DaemonState.Stopped;
            }
            else
            {
                newState = DaemonState.Stopped;
            }
        }
        catch (Exception ex) when (ex is TaskCanceledException
            or HttpRequestException or JsonException)
        {
            newState = DaemonState.Stopped;
        }

        _firstCheckDone = true;

        if (oldState != newState)
        {
            _currentState = newState;
            StateChanged?.Invoke(oldState, newState);
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _timer.Stop();
        _timer.Dispose();
        _http.Dispose();
    }
}
