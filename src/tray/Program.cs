namespace TriLC.Tray;

internal static class Program
{
    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        // 单实例检查（仅允许一个托盘实例）
        using var mutex = new Mutex(true, "TriLC.Tray.SingleInstance", out bool createdNew);
        if (!createdNew)
        {
            MessageBox.Show(
                "TriLC Tray 已在运行中。",
                "TriLC Tray",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }

        Application.Run(new TrayApplicationContext());
        GC.KeepAlive(mutex);
    }
}
