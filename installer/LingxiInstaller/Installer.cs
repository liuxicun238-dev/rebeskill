using Microsoft.Win32;
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using WinForms = System.Windows.Forms;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using Ellipse = System.Windows.Shapes.Ellipse;
using PathShape = System.Windows.Shapes.Path;

namespace LingxiInstaller
{
    internal static class EmbeddedWebView2Bootstrap
    {
        private const string CoreResource = "LingxiPayload.webview2-core.dll";
        private const string WpfResource = "LingxiPayload.webview2-wpf.dll";
        private const string LoaderResource = "LingxiPayload.webview2-loader.dll";
        private static readonly object SyncRoot = new object();
        private static string runtimeDirectory;
        private static bool prepared;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool SetDllDirectory(string lpPathName);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr LoadLibrary(string lpFileName);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FreeLibrary(IntPtr hModule);

        public static void Prepare()
        {
            lock (SyncRoot)
            {
                if (prepared) return;

                runtimeDirectory = Path.Combine(
                    Path.GetTempPath(),
                    "LingxiInstallerBootstrap",
                    "webview2-1.0.0-x64");
                Directory.CreateDirectory(runtimeDirectory);

                ExtractDependency(CoreResource, "Microsoft.Web.WebView2.Core.dll");
                ExtractDependency(WpfResource, "Microsoft.Web.WebView2.Wpf.dll");
                ExtractDependency(LoaderResource, "WebView2Loader.dll");

                AppDomain.CurrentDomain.AssemblyResolve += ResolveManagedDependency;
                if (!SetDllDirectory(runtimeDirectory))
                {
                    throw new System.ComponentModel.Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "无法注册安装器 WebView2 运行目录。");
                }

                prepared = true;
            }
        }

        public static void Verify()
        {
            Prepare();
            Assembly.LoadFrom(Path.Combine(runtimeDirectory, "Microsoft.Web.WebView2.Core.dll"));
            Assembly.LoadFrom(Path.Combine(runtimeDirectory, "Microsoft.Web.WebView2.Wpf.dll"));

            var loaderPath = Path.Combine(runtimeDirectory, "WebView2Loader.dll");
            var handle = LoadLibrary(loaderPath);
            if (handle == IntPtr.Zero)
            {
                throw new System.ComponentModel.Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "无法加载内嵌的 WebView2Loader.dll。");
            }
            FreeLibrary(handle);
        }

        public static void WriteFailure(Exception ex)
        {
            try
            {
                File.AppendAllText(
                    Path.Combine(Path.GetTempPath(), "LingxiInstallerBootstrap.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + ex + Environment.NewLine,
                    System.Text.Encoding.UTF8);
            }
            catch { }
        }

        private static Assembly ResolveManagedDependency(object sender, ResolveEventArgs args)
        {
            string simpleName;
            try { simpleName = new AssemblyName(args.Name).Name; }
            catch { return null; }

            string fileName;
            if (string.Equals(simpleName, "Microsoft.Web.WebView2.Core", StringComparison.OrdinalIgnoreCase))
                fileName = "Microsoft.Web.WebView2.Core.dll";
            else if (string.Equals(simpleName, "Microsoft.Web.WebView2.Wpf", StringComparison.OrdinalIgnoreCase))
                fileName = "Microsoft.Web.WebView2.Wpf.dll";
            else
                return null;

            var path = Path.Combine(runtimeDirectory, fileName);
            return File.Exists(path) ? Assembly.LoadFrom(path) : null;
        }

        private static void ExtractDependency(string resourceName, string fileName)
        {
            var assembly = Assembly.GetExecutingAssembly();
            using (var stream = assembly.GetManifestResourceStream(resourceName))
            {
                if (stream == null) throw new InvalidDataException("安装器缺少内嵌依赖：" + resourceName);

                var target = Path.Combine(runtimeDirectory, fileName);
                if (File.Exists(target) && new FileInfo(target).Length == stream.Length) return;

                var temporary = target + ".tmp-" + Process.GetCurrentProcess().Id;
                try
                {
                    using (var output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
                        stream.CopyTo(output);

                    if (File.Exists(target)) File.Delete(target);
                    File.Move(temporary, target);
                }
                finally
                {
                    try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
                }
            }
        }
    }

    internal sealed class WebGlSceneHost
    {
        private readonly WebView2 browser;
        private readonly Grid root;
        private readonly UIElement fallback;
        private bool ready;
        private bool initializing;
        private double progress;
        private string state = "install";

        public WebGlSceneHost(double width, double height)
        {
            root = new Grid { Width = width, Height = height, HorizontalAlignment = HorizontalAlignment.Center };
            fallback = CreateFallback();
            root.Children.Add(fallback);
            browser = new WebView2 { Width = width, Height = height, HorizontalAlignment = HorizontalAlignment.Center, Visibility = Visibility.Hidden };
            browser.Loaded += Initialize;
            browser.NavigationCompleted += OnNavigationCompleted;
            root.Children.Add(browser);
        }

        public UIElement View { get { return root; } }

        public void SetState(double value, string nextState)
        {
            progress = Math.Max(0, Math.Min(100, value));
            state = nextState ?? "install";
            if (!ready) return;
            try { browser.ExecuteScriptAsync("window.setInstallerState(" + (progress / 100.0).ToString(System.Globalization.CultureInfo.InvariantCulture) + ",'" + state.Replace("'", string.Empty) + "')"); } catch { }
        }

        private async void Initialize(object sender, RoutedEventArgs e)
        {
            if (initializing || ready) return;
            initializing = true;
            try
            {
                var cachePath = Path.Combine(Path.GetTempPath(), "LingxiInstallerWebView2");
                var environment = await CoreWebView2Environment.CreateAsync(null, cachePath);
                await browser.EnsureCoreWebView2Async(environment);
                browser.DefaultBackgroundColor = System.Drawing.Color.Transparent;
                browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
                browser.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
                browser.CoreWebView2.ProcessFailed += OnProcessFailed;
                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("LingxiPayload.webgl-scene.html"))
                using (var reader = stream == null ? null : new StreamReader(stream, System.Text.Encoding.UTF8))
                {
                    if (reader == null)
                    {
                        ShowFallback("embedded WebGL scene resource is missing");
                        return;
                    }
                    browser.NavigateToString(reader.ReadToEnd());
                }
            }
            catch (Exception ex)
            {
                ShowFallback("WebView2 initialization failed: " + ex);
            }
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess)
            {
                ShowFallback("WebGL scene navigation failed: " + e.WebErrorStatus);
            }
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string message;
            try { message = e.TryGetWebMessageAsString() ?? string.Empty; }
            catch (Exception ex)
            {
                ShowFallback("WebGL scene message failed: " + ex);
                return;
            }

            if (string.Equals(message, "scene-ready", StringComparison.OrdinalIgnoreCase))
            {
                ShowBrowser();
                return;
            }

            if (message.StartsWith("scene-failed", StringComparison.OrdinalIgnoreCase))
            {
                ShowFallback("WebGL scene reported failure: " + message);
            }
        }

        private void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            ShowFallback("WebView2 process failed: " + e.ProcessFailedKind);
        }

        private void ShowBrowser()
        {
            if (ready) return;
            ready = true;
            SetState(progress, state);
            browser.Visibility = Visibility.Visible;
            browser.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(260)));
            fallback.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(220)));
        }

        private void ShowFallback(string reason)
        {
            ready = false;
            try
            {
                browser.BeginAnimation(UIElement.OpacityProperty, null);
                browser.Visibility = Visibility.Hidden;
                fallback.BeginAnimation(UIElement.OpacityProperty, null);
                fallback.Opacity = 1;
            }
            catch { }
            WriteDiagnostic(reason);
        }

        private static void WriteDiagnostic(string message)
        {
            try
            {
                File.AppendAllText(
                    Path.Combine(Path.GetTempPath(), "LingxiInstallerWebView2.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + message + Environment.NewLine,
                    System.Text.Encoding.UTF8);
            }
            catch { }
        }

        private static UIElement CreateFallback()
        {
            var root = new Grid { Width = 196, Height = 176, IsHitTestVisible = false, RenderTransformOrigin = new Point(.5, .5) };
            var glow = new RadialGradientBrush(Color.FromArgb(65, 56, 189, 248), Color.FromArgb(0, 7, 17, 31));
            root.Children.Add(new Ellipse { Width = 150, Height = 150, Fill = glow, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center });

            var img = new Image
            {
                Width = 112,
                Height = 112,
                Stretch = Stretch.Uniform,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                Effect = new System.Windows.Media.Effects.DropShadowEffect { Color = Color.FromRgb(37, 99, 235), BlurRadius = 24, ShadowDepth = 0, Opacity = 0.85 }
            };

            try
            {
                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("LingxiPayload.lingxi-logo.png"))
                {
                    if (stream != null)
                    {
                        var bitmap = new BitmapImage();
                        bitmap.BeginInit();
                        bitmap.StreamSource = stream;
                        bitmap.CacheOption = BitmapCacheOption.OnLoad;
                        bitmap.EndInit();
                        bitmap.Freeze();
                        img.Source = bitmap;
                    }
                }
            }
            catch { }

            root.Children.Add(img);

            var scale = new ScaleTransform(1, 1);
            root.RenderTransform = scale;
            var breathe = new DoubleAnimation(1, 1.035, TimeSpan.FromSeconds(2.8))
            {
                AutoReverse = true,
                RepeatBehavior = RepeatBehavior.Forever,
                EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut }
            };
            scale.BeginAnimation(ScaleTransform.ScaleXProperty, breathe);
            scale.BeginAnimation(ScaleTransform.ScaleYProperty, breathe);
            return root;
        }
    }

    public class InstallerApp : System.Windows.Application
    {
        [STAThread]
        public static void Main(string[] args)
        {
            var bootstrapSelfTest = args != null && args.Any(a => string.Equals(a, "--bootstrap-self-test", StringComparison.OrdinalIgnoreCase));
            try
            {
                if (bootstrapSelfTest)
                    EmbeddedWebView2Bootstrap.Verify();
                else
                    EmbeddedWebView2Bootstrap.Prepare();
            }
            catch (Exception ex)
            {
                EmbeddedWebView2Bootstrap.WriteFailure(ex);
                Environment.ExitCode = 31;
                if (!bootstrapSelfTest)
                {
                    System.Windows.MessageBox.Show(
                        "安装器启动依赖释放失败。请重新下载安装包后再试。\n\n详细信息已写入：\n" + Path.Combine(Path.GetTempPath(), "LingxiInstallerBootstrap.log"),
                        "灵犀 LingXiCode 安装",
                        MessageBoxButton.OK,
                        MessageBoxImage.Error);
                }
                return;
            }

            if (bootstrapSelfTest)
            {
                Environment.ExitCode = 0;
                return;
            }

            RunApplication(args);
        }

        [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
        private static void RunApplication(string[] args)
        {
#if UNINSTALLER
            if (args != null && args.Length >= 2 && string.Equals(args[0], "--cleanup-install-dir", StringComparison.OrdinalIgnoreCase))
            {
                CleanupInstallDir(args);
                return;
            }
#endif
            var app = new InstallerApp();
#if UNINSTALLER
            // 支持静默卸载模式，Windows 设置的卸载按钮会调用 QuietUninstallString
            bool silentMode = args != null && Array.Exists(args, a => string.Equals(a, "--silent", StringComparison.OrdinalIgnoreCase));
            var uninstallWindow = new UninstallWindow(silentMode);
            if (silentMode)
            {
                // 静默模式：不显示窗口，直接执行卸载后退出
                uninstallWindow.Loaded += async (s, e) =>
                {
                    await uninstallWindow.ExecuteSilentUninstall();
                    app.Shutdown();
                };
            }
            app.Run(uninstallWindow);
#else
            app.Run(new InstallWindow());
#endif
        }

#if UNINSTALLER
        private static void CleanupInstallDir(string[] args)
        {
            var installDir = args.Length > 1 ? args[1] : "";
            var parentPid = 0;
            if (args.Length > 2) int.TryParse(args[2], out parentPid);
            if (string.IsNullOrWhiteSpace(installDir) || !PathRules.IsSafeInstallDirDeleteTarget(installDir)) return;

            WaitForProcessExit(parentPid, TimeSpan.FromSeconds(20));
            CloseRunningAppProcesses(installDir, true);
            var removed = DeleteDirectoryWithRetries(installDir, 60, TimeSpan.FromMilliseconds(500));
            if (removed)
            {
                try { Shortcut.DeleteShortcuts(); } catch { }
                UninstallRegistration.RemoveAll();
            }
        }

        private static void WaitForProcessExit(int pid, TimeSpan timeout)
        {
            if (pid <= 0) return;
            try
            {
                var process = Process.GetProcessById(pid);
                process.WaitForExit((int)Math.Max(0, timeout.TotalMilliseconds));
            }
            catch { }
        }

        public static bool HasRunningAppProcesses(string installDir)
        {
            var processName = Path.GetFileNameWithoutExtension(InstallerConstants.AppExe);
            foreach (var process in Process.GetProcessesByName(processName))
            {
                try
                {
                    var path = "";
                    var pathReadable = true;
                    try { path = process.MainModule == null ? "" : process.MainModule.FileName; }
                    catch { pathReadable = false; }
                    // 无法读取路径通常意味着目标进程权限更高。此时按“仍在运行”处理，
                    // 宁可停止卸载，也不能冒险删除卸载器并留下残缺安装。
                    if (!pathReadable) return true;
                    if (PathRules.IsInsideDirectory(installDir, path) && !process.HasExited) return true;
                }
                catch { }
                finally { try { process.Dispose(); } catch { } }
            }
            return false;
        }

        public static bool CloseRunningAppProcesses(string installDir, bool force)
        {
            var processName = Path.GetFileNameWithoutExtension(InstallerConstants.AppExe);
            foreach (var process in Process.GetProcessesByName(processName))
            {
                try
                {
                    var path = "";
                    var pathReadable = true;
                    try { path = process.MainModule == null ? "" : process.MainModule.FileName; }
                    catch { pathReadable = false; }
                    if (pathReadable && !PathRules.IsInsideDirectory(installDir, path)) continue;

                    try { process.CloseMainWindow(); } catch { }
                    if (!process.WaitForExit(5000) && force)
                    {
                        try { process.Kill(); } catch { }
                    }
                    try { process.WaitForExit(5000); } catch { }
                }
                catch { }
                finally
                {
                    try { process.Dispose(); } catch { }
                }
            }
            return !HasRunningAppProcesses(installDir);
        }

        private static bool DeleteDirectoryWithRetries(string dir, int attempts, TimeSpan delay)
        {
            for (var i = 0; i < attempts; i++)
            {
                try
                {
                    if (!Directory.Exists(dir)) return true;
                    Directory.Delete(dir, true);
                    if (!Directory.Exists(dir)) return true;
                }
                catch { }

                try { System.Threading.Thread.Sleep(delay); } catch { }
            }
            return !Directory.Exists(dir);
        }
#endif
    }

    public static class InstallerConstants
    {
        public const string AppName = "灵犀 LingXiCode";
        public const string AppVersion = "1.0.0";
        public const string AppExe = "lingxi-lingxicode.exe";
        public const string UninstallerExe = "LingxiUninstall.exe";
        public const string DataPointerFile = "lingxi-data-dir.txt";
        public const string StateDirName = "Lingxi LingXiCode";
        public const string RegistryKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Lingxi LingXiCode";
        public const string RegistryKeyWow6432 = @"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Lingxi LingXiCode";
    }

    public static class UninstallRegistration
    {
        private static void TryDelete(RegistryKey root, string path)
        {
            try { root.DeleteSubKeyTree(path, false); } catch { }
        }

        public static void RemoveUserEntries()
        {
            TryDelete(Registry.CurrentUser, InstallerConstants.RegistryKey);
            TryDelete(Registry.CurrentUser, InstallerConstants.RegistryKeyWow6432);
        }

        public static void RemoveMachineEntries()
        {
            TryDelete(Registry.LocalMachine, InstallerConstants.RegistryKey);
            TryDelete(Registry.LocalMachine, InstallerConstants.RegistryKeyWow6432);
        }

        public static void RemoveAll()
        {
            RemoveUserEntries();
            RemoveMachineEntries();
        }
    }

    public static class PathRules
    {
        public static string DefaultInstallDir()
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(local, "Programs", "lingxi-lingxicode");
        }

        public static string DefaultDataDir(string installDir)
        {
            return Path.Combine(StateDir(), "data");
        }

        public static string StateDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), InstallerConstants.StateDirName);
        }

        public static string DataMarkerPath()
        {
            return Path.Combine(StateDir(), InstallerConstants.DataPointerFile);
        }

        public static string ReadRememberedDataDir()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(InstallerConstants.RegistryKey))
                {
                    var value = key == null ? "" : Convert.ToString(key.GetValue("LingxiDataDir", ""));
                    if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
                }
            }
            catch { }

            try
            {
                var marker = DataMarkerPath();
                if (File.Exists(marker))
                {
                    var value = File.ReadAllText(marker, System.Text.Encoding.UTF8).Trim();
                    if (!string.IsNullOrWhiteSpace(value)) return value;
                }
            }
            catch { }

            return DefaultDataDir("");
        }

        public static void WriteDataMarker(string dataDir)
        {
            if (string.IsNullOrWhiteSpace(dataDir)) return;
            Directory.CreateDirectory(StateDir());
            File.WriteAllText(DataMarkerPath(), dataDir.Trim(), System.Text.Encoding.UTF8);
        }

        public static void DeleteDataMarker()
        {
            try
            {
                var marker = DataMarkerPath();
                if (File.Exists(marker)) File.Delete(marker);
                var stateDir = StateDir();
                if (Directory.Exists(stateDir) && !Directory.EnumerateFileSystemEntries(stateDir).Any()) Directory.Delete(stateDir);
            }
            catch { }
        }

        public static bool IsInsideDirectory(string parent, string child)
        {
            if (string.IsNullOrWhiteSpace(parent) || string.IsNullOrWhiteSpace(child)) return false;
            var parentFull = Path.GetFullPath(parent).TrimEnd('\\') + "\\";
            var childFull = Path.GetFullPath(child).TrimEnd('\\') + "\\";
            return childFull.StartsWith(parentFull, StringComparison.OrdinalIgnoreCase);
        }

        public static string UserApiConfigDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".lingxicode");
        }

        private static string NormalizeForCompare(string path)
        {
            return Path.GetFullPath(path).TrimEnd('\\');
        }

        private static bool IsSamePath(string left, string right)
        {
            if (string.IsNullOrWhiteSpace(left) || string.IsNullOrWhiteSpace(right)) return false;
            return string.Equals(NormalizeForCompare(left), NormalizeForCompare(right), StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsSameOrInsideDirectory(string parent, string child)
        {
            if (string.IsNullOrWhiteSpace(parent) || string.IsNullOrWhiteSpace(child)) return false;
            return IsSamePath(parent, child) || IsInsideDirectory(parent, child);
        }

        public static bool IsSafeDeleteTarget(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return false;
            var full = NormalizeForCompare(path.Trim());
            var root = Path.GetPathRoot(full);
            if (string.Equals(full, root == null ? "" : root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) return false;
            var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            if (!string.IsNullOrEmpty(windows) && IsSameOrInsideDirectory(windows, full)) return false;

            var dangerousExactDirs = new[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)
            };
            foreach (var dir in dangerousExactDirs)
            {
                if (!string.IsNullOrWhiteSpace(dir) && IsSamePath(full, dir)) return false;
            }

            if (string.IsNullOrWhiteSpace(Path.GetFileName(full))) return false;
            return true;
        }

        public static bool IsSafeInstallDirDeleteTarget(string path)
        {
            if (!IsSafeDeleteTarget(path)) return false;
            var full = NormalizeForCompare(path.Trim());
            return File.Exists(Path.Combine(full, InstallerConstants.AppExe))
                || File.Exists(Path.Combine(full, InstallerConstants.UninstallerExe))
                || File.Exists(Path.Combine(full, InstallerConstants.DataPointerFile));
        }
    }

    public static class Ui
    {
        public static Button Button(string text, Brush bg, Brush fg, double cornerRadius = 6)
        {
            var btn = new Button
            {
                Content = text,
                Height = 36,
                MinWidth = 104,
                Padding = new Thickness(16, 0, 16, 0),
                Background = bg,
                Foreground = fg,
                BorderThickness = new Thickness(0),
                FontSize = 13,
                FontWeight = FontWeights.SemiBold,
                Cursor = System.Windows.Input.Cursors.Hand
            };
            return btn;
        }

        public static TextBlock Text(string text, double size, Brush color, FontWeight weight)
        {
            return new TextBlock
            {
                Text = text,
                FontSize = size,
                Foreground = color,
                FontWeight = weight,
                TextWrapping = TextWrapping.Wrap,
                VerticalAlignment = VerticalAlignment.Center
            };
        }

        public static TextBox PathBox(string text)
        {
            return new TextBox
            {
                Text = text,
                Height = 34,
                FontSize = 12,
                Padding = new Thickness(10, 7, 10, 7),
                BorderBrush = new SolidColorBrush(Color.FromRgb(29, 53, 82)),
                Background = new SolidColorBrush(Color.FromRgb(12, 26, 45)),
                Foreground = new SolidColorBrush(Color.FromRgb(244, 248, 255)),
                VerticalContentAlignment = VerticalAlignment.Center
            };
        }

        public static Border Card(UIElement child)
        {
            return new Border
            {
                Child = child,
                Background = new SolidColorBrush(Color.FromRgb(16, 35, 60)),
                CornerRadius = new CornerRadius(10),
                Padding = new Thickness(20, 18, 20, 18),
                BorderBrush = new SolidColorBrush(Color.FromRgb(29, 53, 82)),
                BorderThickness = new Thickness(1),
                Effect = new System.Windows.Media.Effects.DropShadowEffect
                {
                    BlurRadius = 24,
                    ShadowDepth = 4,
                    Opacity = 0.28,
                    Color = Color.FromRgb(2, 6, 12)
                }
            };
        }

        public static string PickFolder(string title, string selected)
        {
            using (var dialog = new WinForms.FolderBrowserDialog())
            {
                dialog.Description = title;
                dialog.SelectedPath = Directory.Exists(selected) ? selected : Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                dialog.ShowNewFolderButton = true;
                return dialog.ShowDialog() == WinForms.DialogResult.OK ? dialog.SelectedPath : null;
            }
        }
    }

#if !UNINSTALLER
    public class InstallWindow : Window
    {
        private TextBox installPath;
        private TextBox dataPath;
        private CheckBox desktopShortcut;
        private CheckBox startShortcut;
        private CheckBox launchAfterInstall;
        private Grid progressTrack;
        private Border progressFill;
        private Border progressShine;
        private TextBlock progressPercent;
        private double currentProgressValue;
        private WebGlSceneHost webGlScene;
        private TextBlock status;
        private Button installButton;
        private bool dataPathTouched;

        public InstallWindow()
        {
            Title = InstallerConstants.AppName + " 安装";
            Width = 900;
            Height = 548;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            ResizeMode = ResizeMode.NoResize;
            Background = new SolidColorBrush(Color.FromRgb(7, 17, 31));
            Icon = LoadIcon();
            Build();
        }

        private ImageSource LoadIcon()
        {
            try
            {
                var iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "灵犀logo.ico");
                if (File.Exists(iconPath)) return BitmapFrame.Create(new Uri(iconPath));
            }
            catch { }
            return null;
        }

        private void Build()
        {
            var root = new Grid();
            root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(286) });
            root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var brand = CreateBrandPanel("安装向导", "", "软件与数据位置可分别设置。升级或卸载时，项目数据默认受到保护。", Color.FromRgb(37, 131, 255));
            Grid.SetColumn(brand, 0);
            root.Children.Add(brand);

            var content = new StackPanel { Margin = new Thickness(34, 28, 34, 22) };
            Grid.SetColumn(content, 1);
            content.Children.Add(Ui.Text("安装 " + InstallerConstants.AppName, 24, new SolidColorBrush(Color.FromRgb(244, 248, 255)), FontWeights.Bold));
            content.Children.Add(new TextBlock { Text = "确认安装位置与使用偏好", Margin = new Thickness(0, 7, 0, 18), FontSize = 13, Foreground = new SolidColorBrush(Color.FromRgb(145, 165, 194)) });

            var form = new StackPanel();
            form.Children.Add(Ui.Text("软件安装位置", 13, new SolidColorBrush(Color.FromRgb(226, 232, 240)), FontWeights.SemiBold));
            form.Children.Add(PathRow(out installPath, PathRules.DefaultInstallDir(), () => BrowseInstall()));
            form.Children.Add(new TextBlock { Margin = new Thickness(0, 12, 0, 0) });
            form.Children.Add(Ui.Text("数据存储位置", 13, new SolidColorBrush(Color.FromRgb(226, 232, 240)), FontWeights.SemiBold));
            form.Children.Add(PathRow(out dataPath, PathRules.ReadRememberedDataDir(), () => BrowseData()));
            form.Children.Add(new TextBlock { Text = "项目列表、上下文、账本、缓存、记忆会保存在这里，推荐安装在空间充足的系统盘。", Margin = new Thickness(0, 6, 0, 12), FontSize = 12, Foreground = new SolidColorBrush(Color.FromRgb(145, 165, 194)), TextWrapping = TextWrapping.Wrap });

            installPath.TextChanged += (s, e) =>
            {
                if (!dataPathTouched) dataPath.Text = PathRules.DefaultDataDir(installPath.Text.Trim());
            };
            dataPath.TextChanged += (s, e) => { if (dataPath.IsKeyboardFocusWithin) dataPathTouched = true; };

            var options = new StackPanel { Orientation = System.Windows.Controls.Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 4) };
            desktopShortcut = new CheckBox { Content = "桌面快捷方式", IsChecked = true, Margin = new Thickness(0, 0, 20, 0), FontSize = 13, Foreground = new SolidColorBrush(Color.FromRgb(226, 232, 240)) };
            startShortcut = new CheckBox { Content = "开始菜单快捷方式", IsChecked = true, Margin = new Thickness(0, 0, 20, 0), FontSize = 13, Foreground = new SolidColorBrush(Color.FromRgb(226, 232, 240)) };
            launchAfterInstall = new CheckBox { Content = "安装完成后启动", IsChecked = true, FontSize = 13, Foreground = new SolidColorBrush(Color.FromRgb(226, 232, 240)) };
            options.Children.Add(desktopShortcut);
            options.Children.Add(startShortcut);
            options.Children.Add(launchAfterInstall);
            form.Children.Add(options);

            content.Children.Add(Ui.Card(form));

            content.Children.Add(CreateProgressVisual());

            var actions = new StackPanel { Orientation = System.Windows.Controls.Orientation.Horizontal, HorizontalAlignment = System.Windows.HorizontalAlignment.Right, Margin = new Thickness(0, 8, 0, 0) };
            var cancel = Ui.Button("取消", new SolidColorBrush(Color.FromRgb(16, 35, 60)), new SolidColorBrush(Color.FromRgb(145, 165, 194)));
            cancel.BorderBrush = new SolidColorBrush(Color.FromRgb(29, 53, 82));
            cancel.BorderThickness = new Thickness(1);
            cancel.Click += (s, e) => Close();
            installButton = Ui.Button("开始安装", new LinearGradientBrush(Color.FromRgb(37, 131, 255), Color.FromRgb(29, 100, 236), new Point(0, 0), new Point(1, 1)), Brushes.White);
            installButton.Margin = new Thickness(12, 0, 0, 0);
            installButton.Click += async (s, e) => await InstallAsync();
            actions.Children.Add(cancel);
            actions.Children.Add(installButton);
            content.Children.Add(actions);

            root.Children.Add(content);
            Content = root;
        }

        private Border CreateBrandPanel(string eyebrow, string badge, string description, Color accent)
        {
            var panel = new Grid { Margin = new Thickness(32, 34, 30, 30) };
            panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            panel.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            var heading = new StackPanel();
            heading.Children.Add(new TextBlock { Text = eyebrow.ToUpperInvariant(), FontSize = 11, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(Color.FromRgb(56, 200, 255)) });
            heading.Children.Add(Ui.Text(InstallerConstants.AppName, 25, new SolidColorBrush(Color.FromRgb(244, 248, 255)), FontWeights.Bold));
            heading.Children.Add(new TextBlock { Text = "桌面端 AI 工作空间", Margin = new Thickness(0, 6, 0, 0), FontSize = 13, Foreground = new SolidColorBrush(Color.FromRgb(145, 165, 194)) });
            panel.Children.Add(heading);

            var center = new StackPanel { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = System.Windows.HorizontalAlignment.Center };
            webGlScene = new WebGlSceneHost(196, 176);
            center.Children.Add(webGlScene.View);
            if (!string.IsNullOrWhiteSpace(badge))
            {
                var badgeBorder = new Border { Margin = new Thickness(0, 20, 0, 0), Padding = new Thickness(12, 6, 12, 6), CornerRadius = new CornerRadius(12), Background = new SolidColorBrush(Color.FromArgb(34, accent.R, accent.G, accent.B)), BorderBrush = new SolidColorBrush(Color.FromArgb(72, accent.R, accent.G, accent.B)), BorderThickness = new Thickness(1) };
                badgeBorder.Child = new TextBlock { Text = badge, FontSize = 11, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(Color.FromRgb(219, 234, 254)) };
                center.Children.Add(badgeBorder);
            }
            Grid.SetRow(center, 1);
            panel.Children.Add(center);

            var footer = new StackPanel();
            footer.Children.Add(new Border { Height = 1, Margin = new Thickness(0, 0, 0, 15), Background = new SolidColorBrush(Color.FromArgb(38, 255, 255, 255)) });
            footer.Children.Add(new TextBlock { Text = description, FontSize = 12, LineHeight = 19, Foreground = new SolidColorBrush(Color.FromRgb(145, 165, 194)), TextWrapping = TextWrapping.Wrap });
            Grid.SetRow(footer, 2);
            panel.Children.Add(footer);

            return new Border { Background = new LinearGradientBrush(Color.FromRgb(10, 25, 48), Color.FromRgb(12, 30, 58), new Point(0, 0), new Point(1, 1)), Child = panel };
        }

        private UIElement CreateProgressVisual()
        {
            var progressPanel = new StackPanel { Margin = new Thickness(4, 14, 4, 10) };
            var progressHeader = new Grid { Margin = new Thickness(0, 0, 0, 7) };
            progressHeader.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            progressHeader.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            status = new TextBlock { Text = "准备安装", FontSize = 12, FontWeight = FontWeights.Medium, Foreground = new SolidColorBrush(Color.FromRgb(145, 165, 194)) };
            progressPercent = new TextBlock { Text = "0%", FontSize = 11, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(Color.FromRgb(56, 200, 255)) };
            Grid.SetColumn(progressPercent, 1);
            progressHeader.Children.Add(status);
            progressHeader.Children.Add(progressPercent);
            progressPanel.Children.Add(progressHeader);

            progressTrack = new Grid
            {
                Height = 6,
                ClipToBounds = true,
                Background = Brushes.Transparent
            };
            progressTrack.SizeChanged += (s, e) => UpdateProgressVisual(currentProgressValue);

            var bg = new Border
            {
                CornerRadius = new CornerRadius(3),
                Background = new SolidColorBrush(Color.FromRgb(12, 26, 45)),
                BorderBrush = new SolidColorBrush(Color.FromRgb(29, 53, 82)),
                BorderThickness = new Thickness(1)
            };
            progressTrack.Children.Add(bg);

            progressFill = new Border
            {
                Width = 0,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Left,
                CornerRadius = new CornerRadius(3),
                Background = new LinearGradientBrush(
                    Color.FromRgb(37, 131, 255),
                    Color.FromRgb(56, 200, 255),
                    new Point(0, 0.5),
                    new Point(1, 0.5))
            };
            progressTrack.Children.Add(progressFill);

            progressShine = new Border
            {
                Width = 72,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Left,
                CornerRadius = new CornerRadius(3),
                Opacity = 0.35,
                Background = new LinearGradientBrush(
                    Color.FromArgb(0, 255, 255, 255),
                    Color.FromArgb(210, 255, 255, 255),
                    new Point(0, 0.5),
                    new Point(1, 0.5)),
                RenderTransform = new TranslateTransform(-80, 0)
            };
            progressTrack.Children.Add(progressShine);
            progressPanel.Children.Add(progressTrack);
            return progressPanel;
        }

        private void UpdateProgressVisual(double value)
        {
            currentProgressValue = Math.Max(0, Math.Min(100, value));
            if (webGlScene != null) webGlScene.SetState(currentProgressValue, currentProgressValue >= 100 ? "complete" : "install");
            if (progressPercent != null) progressPercent.Text = Math.Round(currentProgressValue).ToString("0") + "%";
            if (progressTrack == null || progressFill == null) return;
            var width = Math.Max(0, progressTrack.ActualWidth * currentProgressValue / 100.0);
            progressFill.BeginAnimation(FrameworkElement.WidthProperty, new DoubleAnimation
            {
                To = width,
                Duration = TimeSpan.FromMilliseconds(360),
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
            });
            if (progressShine != null && progressTrack.ActualWidth > 0 && currentProgressValue > 0 && currentProgressValue < 100)
            {
                var transform = progressShine.RenderTransform as TranslateTransform;
                if (transform != null)
                {
                    transform.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation
                    {
                        From = -80,
                        To = Math.Max(100, progressTrack.ActualWidth + 40),
                        Duration = TimeSpan.FromSeconds(1.6),
                        RepeatBehavior = RepeatBehavior.Forever
                    });
                }
            }
        }

        private UIElement PathRow(out TextBox box, string initial, Action browse)
        {
            var grid = new Grid { Margin = new Thickness(0, 6, 0, 0) };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(96) });
            box = Ui.PathBox(initial);
            Grid.SetColumn(box, 0);
            grid.Children.Add(box);
            var btn = Ui.Button("浏览", new SolidColorBrush(Color.FromRgb(24, 48, 80)), new SolidColorBrush(Color.FromRgb(226, 232, 240)));
            btn.Height = 34;
            btn.Margin = new Thickness(10, 0, 0, 0);
            btn.BorderBrush = new SolidColorBrush(Color.FromRgb(29, 53, 82));
            btn.BorderThickness = new Thickness(1);
            btn.Click += (s, e) => browse();
            Grid.SetColumn(btn, 1);
            grid.Children.Add(btn);
            return grid;
        }

        private void BrowseInstall()
        {
            var selected = Ui.PickFolder("选择软件安装位置", installPath.Text);
            if (!string.IsNullOrEmpty(selected)) installPath.Text = selected;
        }

        private void BrowseData()
        {
            var selected = Ui.PickFolder("选择数据存储位置", dataPath.Text);
            if (!string.IsNullOrEmpty(selected))
            {
                dataPathTouched = true;
                dataPath.Text = selected;
            }
        }

        private async Task InstallAsync()
        {
            var installDir = installPath.Text.Trim();
            var dataDir = dataPath.Text.Trim();
            if (string.IsNullOrWhiteSpace(installDir) || string.IsNullOrWhiteSpace(dataDir))
            {
                System.Windows.MessageBox.Show("请选择软件安装位置和数据存储位置。", InstallerConstants.AppName, MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            var createDesktopShortcut = desktopShortcut.IsChecked == true;
            var createStartShortcut = startShortcut.IsChecked == true;
            var launchWhenDone = launchAfterInstall.IsChecked == true;
            installButton.IsEnabled = false;
            await Task.Run(() => InstallCore(installDir, dataDir, createDesktopShortcut, createStartShortcut, launchWhenDone));
        }

        private void SetStatus(string text, double value)
        {
            Dispatcher.Invoke(() => { status.Text = text; UpdateProgressVisual(value); });
        }

        private void InstallCore(string installDir, string dataDir, bool createDesktopShortcut, bool createStartShortcut, bool launchWhenDone)
        {
            try
            {
                SetStatus("正在安装中，请稍等", 8);
                Directory.CreateDirectory(installDir);
                Directory.CreateDirectory(dataDir);
                PathRules.WriteDataMarker(dataDir);

                SetStatus("正在安装中，请稍等", 18);
                ExtractZipResource("LingxiPayload.app.zip", installDir);

                SetStatus("正在安装中，请稍等", 72);
                File.WriteAllText(Path.Combine(installDir, InstallerConstants.DataPointerFile), dataDir, System.Text.Encoding.UTF8);

                SetStatus("正在安装中，请稍等", 78);
                ExtractBinaryResource("LingxiPayload.uninstaller.exe", Path.Combine(installDir, InstallerConstants.UninstallerExe));

                SetStatus("正在安装中，请稍等", 84);
                var exePath = Path.Combine(installDir, InstallerConstants.AppExe);
                if (createDesktopShortcut)
                    Shortcut.Create(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), InstallerConstants.AppName + ".lnk", exePath, installDir);
                if (createStartShortcut)
                {
                    var startDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", InstallerConstants.AppName);
                    Directory.CreateDirectory(startDir);
                    Shortcut.Create(startDir, InstallerConstants.AppName + ".lnk", exePath, installDir);
                }

                SetStatus("正在安装中，请稍等", 92);
                RegisterUninstall(installDir, dataDir);

                SetStatus("安装完成，窗口即将自动关闭", 100);
                Dispatcher.Invoke(() =>
                {
                    installButton.Content = "已完成";
                    installButton.IsEnabled = false;
                    if (launchWhenDone && File.Exists(exePath)) Process.Start(exePath);
                });
                System.Threading.Thread.Sleep(900);
                Dispatcher.Invoke(() => Close());
            }
            catch (Exception ex)
            {
                Dispatcher.Invoke(() =>
                {
                    installButton.IsEnabled = true;
                    status.Text = "安装失败：" + ex.Message;
                    System.Windows.MessageBox.Show(ex.Message, "安装失败", MessageBoxButton.OK, MessageBoxImage.Error);
                });
            }
        }

        private void ExtractZipResource(string resourceName, string targetDir)
        {
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
            {
                if (stream == null) throw new InvalidOperationException("安装包资源缺失：" + resourceName);
                using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
                {
                    foreach (var entry in archive.Entries)
                    {
                        var target = Path.GetFullPath(Path.Combine(targetDir, entry.FullName));
                        var root = Path.GetFullPath(targetDir).TrimEnd('\\') + "\\";
                        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(target);
                            continue;
                        }
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        entry.ExtractToFile(target, true);
                    }
                }
            }
        }

        private void ExtractBinaryResource(string resourceName, string target)
        {
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
            {
                if (stream == null) throw new InvalidOperationException("安装包资源缺失：" + resourceName);
                using (var output = File.Create(target)) stream.CopyTo(output);
            }
        }

        private void RegisterUninstall(string installDir, string dataDir)
        {
            var uninstallerPath = "\"" + Path.Combine(installDir, InstallerConstants.UninstallerExe) + "\"";
            RegisterUninstallKey(Registry.CurrentUser.CreateSubKey(InstallerConstants.RegistryKey), installDir, dataDir, uninstallerPath);
            // 这是按用户安装的软件，只保留 HKCU 卸载项。旧版本曾尝试写入
            // HKLM/WOW6432Node，可能造成卸载后“应用和功能”残留占位；能清则清。
            UninstallRegistration.RemoveMachineEntries();
        }

        private static void RegisterUninstallKey(RegistryKey key, string installDir, string dataDir, string uninstallerPath)
        {
            if (key == null) return;
            using (key)
            {
                key.SetValue("DisplayName", InstallerConstants.AppName);
                key.SetValue("DisplayVersion", InstallerConstants.AppVersion);
                key.SetValue("Publisher", "LingXiCode");
                key.SetValue("InstallLocation", installDir);
                key.SetValue("UninstallString", uninstallerPath);
                key.SetValue("QuietUninstallString", uninstallerPath + " --silent");
                key.SetValue("DisplayIcon", Path.Combine(installDir, InstallerConstants.AppExe));
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                key.SetValue("LingxiDataDir", dataDir);
            }
        }
    }
#endif

#if UNINSTALLER
    public class UninstallWindow : Window
    {
        private string installDir;
        private string dataDir;
        private string apiDir;
        private CheckBox deleteData;
        private CheckBox deleteApi;
        private TextBlock status;
        private Button uninstallButton;
        private Grid uninstallProgressTrack;
        private Border uninstallProgressFill;
        private Border uninstallProgressShine;
        private TextBlock uninstallProgressPercent;
        private double uninstallProgressValue;
        private WebGlSceneHost uninstallWebGlScene;
        private bool silentMode;

        public UninstallWindow(bool silentMode = false)
        {
            this.silentMode = silentMode;
            installDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            dataDir = ReadDataDir();
            apiDir = PathRules.UserApiConfigDir();
            Title = InstallerConstants.AppName + " 卸载";
            Width = 900;
            Height = 520;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            ResizeMode = ResizeMode.NoResize;
            Background = new SolidColorBrush(Color.FromRgb(7, 17, 31));
            if (!silentMode)
            {
                Build();
            }
            else
            {
                // 静默模式：最小化窗口，不显示 UI
                WindowState = WindowState.Minimized;
                ShowInTaskbar = false;
                Visibility = Visibility.Hidden;
            }
        }

        /// <summary>
        /// 静默模式卸载入口，执行完成后调用方负责关闭应用
        /// </summary>
        public async Task ExecuteSilentUninstall()
        {
            await Task.Run(() =>
            {
                try
                {
                    // 静默卸载也必须先退出正在运行的客户端。无法退出时保留安装目录和卸载项，
                    // 让用户仍可重试，不能制造“卸载器没了但系统条目还在”的残留状态。
                    if (!InstallerApp.CloseRunningAppProcesses(installDir, true)) return;
                    // 1. 删除快捷方式
                    try { Shortcut.DeleteShortcuts(); } catch { }
                    // 2. 保留用户数据（静默模式默认保留，与手动卸载不勾选一致）
                    try { PreserveDataBeforeRemovingInstallDir(); } catch { }
                    // 3. 调度删除安装目录（使用 helper 进程）。卸载注册表项由 helper 在
                    // 安装目录确实删除成功之后移除。
                    try { ScheduleInstallDirRemoval(); } catch { }
                }
                catch
                {
                    // 静默模式静默失败
                }
            });
        }

        private string ReadDataDir()
        {
            try
            {
                var pointer = Path.Combine(installDir, InstallerConstants.DataPointerFile);
                if (File.Exists(pointer)) return File.ReadAllText(pointer, System.Text.Encoding.UTF8).Trim();
            }
            catch { }
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(InstallerConstants.RegistryKey))
                {
                    var value = key == null ? "" : Convert.ToString(key.GetValue("LingxiDataDir", ""));
                    if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
                }
            }
            catch { }
            try
            {
                var remembered = PathRules.ReadRememberedDataDir();
                if (!string.IsNullOrWhiteSpace(remembered)) return remembered;
            }
            catch { }
            return Path.Combine(installDir, "data");
        }

        private void Build()
        {
            var root = new Grid();
            root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(286) });
            root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var brand = CreateUninstallBrandPanel();
            Grid.SetColumn(brand, 0);
            root.Children.Add(brand);

            var content = new StackPanel { Margin = new Thickness(34, 28, 34, 22) };
            Grid.SetColumn(content, 1);
            content.Children.Add(Ui.Text("卸载 " + InstallerConstants.AppName, 24, new SolidColorBrush(Color.FromRgb(244, 248, 255)), FontWeights.Bold));
            content.Children.Add(new TextBlock { Text = "选择需要移除的内容", Margin = new Thickness(0, 7, 0, 18), FontSize = 13, Foreground = new SolidColorBrush(Color.FromRgb(145, 165, 194)) });

            var panel = new StackPanel();
            panel.Children.Add(new TextBlock { Text = "软件目录：" + installDir, FontSize = 12, Foreground = new SolidColorBrush(Color.FromRgb(145, 165, 194)), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12) });
            deleteData = new CheckBox { Content = "同时删除项目数据、上下文、账本、缓存、记忆", IsChecked = false, FontSize = 13, Foreground = new SolidColorBrush(Color.FromRgb(226, 232, 240)), Margin = new Thickness(0, 0, 0, 5) };
            panel.Children.Add(deleteData);
            panel.Children.Add(new TextBlock { Text = dataDir, FontSize = 12, Foreground = new SolidColorBrush(Color.FromRgb(125, 145, 175)), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(22, 0, 0, 10) });
            deleteApi = new CheckBox { Content = "同时删除模型 API 配置（.lingxicode）", IsChecked = false, FontSize = 13, Foreground = new SolidColorBrush(Color.FromRgb(226, 232, 240)), Margin = new Thickness(0, 0, 0, 5) };
            panel.Children.Add(deleteApi);
            panel.Children.Add(new TextBlock { Text = apiDir, FontSize = 12, Foreground = new SolidColorBrush(Color.FromRgb(125, 145, 175)), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(22, 0, 0, 0) });
            content.Children.Add(Ui.Card(panel));

            content.Children.Add(CreateUninstallProgressVisual());

            var actions = new StackPanel { Orientation = System.Windows.Controls.Orientation.Horizontal, HorizontalAlignment = System.Windows.HorizontalAlignment.Right, Margin = new Thickness(0, 8, 0, 0) };
            var cancel = Ui.Button("取消", new SolidColorBrush(Color.FromRgb(16, 35, 60)), new SolidColorBrush(Color.FromRgb(145, 165, 194)));
            cancel.BorderBrush = new SolidColorBrush(Color.FromRgb(29, 53, 82));
            cancel.BorderThickness = new Thickness(1);
            cancel.Click += (s, e) => Close();
            uninstallButton = Ui.Button("开始卸载", new SolidColorBrush(Color.FromRgb(220, 38, 38)), Brushes.White);
            uninstallButton.Margin = new Thickness(12, 0, 0, 0);
            uninstallButton.Click += async (s, e) => await UninstallAsync();
            actions.Children.Add(cancel);
            actions.Children.Add(uninstallButton);
            content.Children.Add(actions);

            root.Children.Add(content);
            Content = root;
        }

        private Border CreateUninstallBrandPanel()
        {
            var panel = new Grid { Margin = new Thickness(32, 34, 30, 30) };
            panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            panel.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var heading = new StackPanel();
            heading.Children.Add(new TextBlock { Text = "安全卸载", FontSize = 11, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(Color.FromRgb(56, 200, 255)) });
            heading.Children.Add(Ui.Text(InstallerConstants.AppName, 25, new SolidColorBrush(Color.FromRgb(244, 248, 255)), FontWeights.Bold));
            heading.Children.Add(new TextBlock { Text = "清理软件，保留你的工作", Margin = new Thickness(0, 6, 0, 0), FontSize = 13, Foreground = new SolidColorBrush(Color.FromRgb(145, 165, 194)) });
            panel.Children.Add(heading);
            var center = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            uninstallWebGlScene = new WebGlSceneHost(196, 142);
            center.Children.Add(uninstallWebGlScene.View);
            center.Children.Add(new TextBlock { Text = "默认保护", FontSize = 12, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(Color.FromRgb(147, 197, 253)), HorizontalAlignment = System.Windows.HorizontalAlignment.Center });
            center.Children.Add(Ui.Text("项目数据", 24, new SolidColorBrush(Color.FromRgb(244, 248, 255)), FontWeights.Bold));
            center.Children.Add(new TextBlock { Text = "只有主动勾选，数据与模型 API 配置才会被删除。", Width = 196, Margin = new Thickness(0, 12, 0, 0), FontSize = 12, LineHeight = 19, Foreground = new SolidColorBrush(Color.FromRgb(145, 165, 194)), TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap });
            Grid.SetRow(center, 1);
            panel.Children.Add(center);
            var footer = new StackPanel();
            footer.Children.Add(new Border { Height = 1, Margin = new Thickness(0, 0, 0, 15), Background = new SolidColorBrush(Color.FromArgb(38, 255, 255, 255)) });
            footer.Children.Add(new TextBlock { Text = "卸载完成后会显示处理结果，已保留的数据可在重新安装后继续使用。", FontSize = 12, LineHeight = 19, Foreground = new SolidColorBrush(Color.FromRgb(145, 165, 194)), TextWrapping = TextWrapping.Wrap });
            Grid.SetRow(footer, 2);
            panel.Children.Add(footer);
            return new Border { Background = new LinearGradientBrush(Color.FromRgb(10, 25, 48), Color.FromRgb(12, 30, 58), new Point(0, 0), new Point(1, 1)), Child = panel };
        }


        private UIElement CreateUninstallProgressVisual()
        {
            var progressPanel = new StackPanel { Margin = new Thickness(4, 16, 4, 14) };
            var progressHeader = new Grid { Margin = new Thickness(0, 0, 0, 7) };
            progressHeader.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            progressHeader.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            status = new TextBlock { Text = "准备卸载", FontSize = 12, FontWeight = FontWeights.Medium, Foreground = new SolidColorBrush(Color.FromRgb(145, 165, 194)) };
            uninstallProgressPercent = new TextBlock { Text = "0%", FontSize = 11, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(Color.FromRgb(56, 200, 255)) };
            Grid.SetColumn(uninstallProgressPercent, 1);
            progressHeader.Children.Add(status);
            progressHeader.Children.Add(uninstallProgressPercent);
            progressPanel.Children.Add(progressHeader);

            uninstallProgressTrack = new Grid
            {
                Height = 6,
                ClipToBounds = true,
                Background = Brushes.Transparent
            };
            uninstallProgressTrack.SizeChanged += (s, e) => UpdateUninstallProgressVisual(uninstallProgressValue);
            uninstallProgressTrack.Children.Add(new Border
            {
                CornerRadius = new CornerRadius(3),
                Background = new SolidColorBrush(Color.FromRgb(12, 26, 45)),
                BorderBrush = new SolidColorBrush(Color.FromRgb(29, 53, 82)),
                BorderThickness = new Thickness(1)
            });
            uninstallProgressFill = new Border
            {
                Width = 0,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Left,
                CornerRadius = new CornerRadius(3),
                Background = new LinearGradientBrush(Color.FromRgb(37, 131, 255), Color.FromRgb(56, 200, 255), new Point(0, 0.5), new Point(1, 0.5))
            };
            uninstallProgressTrack.Children.Add(uninstallProgressFill);
            uninstallProgressShine = new Border
            {
                Width = 72,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Left,
                CornerRadius = new CornerRadius(3),
                Opacity = 0.22,
                Background = new LinearGradientBrush(Color.FromArgb(0, 255, 255, 255), Color.FromArgb(210, 255, 255, 255), new Point(0, 0.5), new Point(1, 0.5)),
                RenderTransform = new TranslateTransform(-80, 0)
            };
            uninstallProgressTrack.Children.Add(uninstallProgressShine);
            progressPanel.Children.Add(uninstallProgressTrack);
            return progressPanel;
        }

        private void UpdateUninstallProgressVisual(double value)
        {
            uninstallProgressValue = Math.Max(0, Math.Min(100, value));
            if (uninstallWebGlScene != null) uninstallWebGlScene.SetState(uninstallProgressValue, uninstallProgressValue >= 100 ? "complete" : "uninstall");
            if (uninstallProgressPercent != null) uninstallProgressPercent.Text = Math.Round(uninstallProgressValue).ToString("0") + "%";
            if (uninstallProgressTrack == null || uninstallProgressFill == null) return;
            var width = Math.Max(0, uninstallProgressTrack.ActualWidth * uninstallProgressValue / 100.0);
            uninstallProgressFill.BeginAnimation(FrameworkElement.WidthProperty, new DoubleAnimation
            {
                To = width,
                Duration = TimeSpan.FromMilliseconds(300),
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
            });
            if (uninstallProgressShine != null && uninstallProgressTrack.ActualWidth > 0 && uninstallProgressValue > 0 && uninstallProgressValue < 100)
            {
                var transform = uninstallProgressShine.RenderTransform as TranslateTransform;
                if (transform != null)
                {
                    transform.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation
                    {
                        From = -80,
                        To = Math.Max(100, uninstallProgressTrack.ActualWidth + 40),
                        Duration = TimeSpan.FromSeconds(1.6),
                        RepeatBehavior = RepeatBehavior.Forever
                    });
                }
            }
        }

        private async Task UninstallAsync()
        {
            var removeData = deleteData.IsChecked == true;
            var removeApi = deleteApi.IsChecked == true;
            uninstallButton.IsEnabled = false;

            if (InstallerApp.HasRunningAppProcesses(installDir))
            {
                var answer = System.Windows.MessageBox.Show(
                    "检测到灵犀 LingXiCode 正在运行。卸载前必须先关闭软件。\n\n是否立即关闭灵犀并继续卸载？",
                    "需要关闭灵犀",
                    MessageBoxButton.YesNo,
                    MessageBoxImage.Warning);
                if (answer != MessageBoxResult.Yes)
                {
                    uninstallButton.IsEnabled = true;
                    status.Text = "已取消卸载，请先关闭灵犀 LingXiCode";
                    return;
                }

                SetStatus("正在关闭灵犀 LingXiCode", 6);
                var closed = await Task.Run(() => InstallerApp.CloseRunningAppProcesses(installDir, true));
                if (!closed)
                {
                    uninstallButton.IsEnabled = true;
                    status.Text = "无法关闭灵犀 LingXiCode，卸载已停止";
                    System.Windows.MessageBox.Show(
                        "无法关闭正在运行的灵犀 LingXiCode。请先在任务管理器中结束相关进程，再重新卸载。",
                        "无法继续卸载",
                        MessageBoxButton.OK,
                        MessageBoxImage.Error);
                    return;
                }
            }

            await Task.Run(() => UninstallCore(removeData, removeApi));
        }

        private void SetStatus(string text, double value)
        {
            Dispatcher.Invoke(() => { status.Text = text; UpdateUninstallProgressVisual(value); });
        }

        private void UninstallCore(bool removeData, bool removeApi)
        {
            try
            {
                SetStatus("正在卸载中，请稍等", 12);
                Shortcut.DeleteShortcuts();

                if (removeData && Directory.Exists(dataDir) && PathRules.IsSafeDeleteTarget(dataDir))
                {
                    SetStatus("正在卸载中，请稍等", 46);
                    Directory.Delete(dataDir, true);
                    PathRules.DeleteDataMarker();
                }
                else if (!removeData)
                {
                    SetStatus("正在保留用户数据", 46);
                    PreserveDataBeforeRemovingInstallDir();
                }
                if (removeApi && Directory.Exists(apiDir) && PathRules.IsSafeDeleteTarget(apiDir))
                {
                    SetStatus("正在卸载中，请稍等", 66);
                    Directory.Delete(apiDir, true);
                }

                SetStatus("正在卸载中，请稍等", 90);
                ScheduleInstallDirRemoval();
                SetStatus("正在完成卸载清理", 100);
                System.Threading.Thread.Sleep(350);
                Dispatcher.Invoke(() =>
                {
                    if (!silentMode)
                    {
                        System.Windows.MessageBox.Show(
                            "灵犀 LingXiCode 已停止运行。关闭此窗口后将删除安装目录和系统卸载项。",
                            "正在完成卸载",
                            MessageBoxButton.OK,
                            MessageBoxImage.Information);
                    }
                    Close();
                });
            }
            catch (Exception ex)
            {
                Dispatcher.Invoke(() =>
                {
                    uninstallButton.IsEnabled = true;
                    status.Text = "卸载失败：" + ex.Message;
                    System.Windows.MessageBox.Show(ex.Message, "卸载失败", MessageBoxButton.OK, MessageBoxImage.Error);
                });
            }
        }

        private void ScheduleInstallDirRemoval()
        {
            if (string.IsNullOrWhiteSpace(installDir) || !PathRules.IsSafeInstallDirDeleteTarget(installDir))
            {
                throw new InvalidOperationException("安装目录不安全，已停止卸载清理。");
            }

            var currentExe = Process.GetCurrentProcess().MainModule.FileName;
            var helperDir = Path.Combine(Path.GetTempPath(), "lingxi-uninstall-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(helperDir);
            var helperExe = Path.Combine(helperDir, InstallerConstants.UninstallerExe);
            File.Copy(currentExe, helperExe, true);

            var args = "--cleanup-install-dir \"" + installDir.Replace("\"", "") + "\" " + Process.GetCurrentProcess().Id;
            Process.Start(new ProcessStartInfo(helperExe, args)
            {
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = helperDir
            });
        }

        private void PreserveDataBeforeRemovingInstallDir()
        {
            if (string.IsNullOrWhiteSpace(dataDir)) return;

            var preservedDataDir = dataDir;
            if (Directory.Exists(dataDir) && PathRules.IsInsideDirectory(installDir, dataDir))
            {
                preservedDataDir = PathRules.DefaultDataDir("");
                if (!string.Equals(Path.GetFullPath(dataDir).TrimEnd('\\'), Path.GetFullPath(preservedDataDir).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                {
                    CopyDirectory(dataDir, preservedDataDir);
                }
            }

            PathRules.WriteDataMarker(preservedDataDir);
        }

        private void CopyDirectory(string sourceDir, string targetDir)
        {
            Directory.CreateDirectory(targetDir);
            foreach (var directory in Directory.GetDirectories(sourceDir, "*", SearchOption.AllDirectories))
            {
                var relative = directory.Substring(sourceDir.Length).TrimStart('\\');
                Directory.CreateDirectory(Path.Combine(targetDir, relative));
            }
            foreach (var file in Directory.GetFiles(sourceDir, "*", SearchOption.AllDirectories))
            {
                var relative = file.Substring(sourceDir.Length).TrimStart('\\');
                var target = Path.Combine(targetDir, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                File.Copy(file, target, true);
            }
        }
    }
#endif

    public static class Shortcut
    {
        public static void Create(string folder, string name, string target, string workingDir)
        {
            Directory.CreateDirectory(folder);
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            dynamic shell = Activator.CreateInstance(shellType);
            dynamic shortcut = shell.CreateShortcut(Path.Combine(folder, name));
            shortcut.TargetPath = target;
            shortcut.WorkingDirectory = workingDir;
            shortcut.IconLocation = target;
            shortcut.Save();
        }

        public static void DeleteShortcuts()
        {
            TryDelete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), InstallerConstants.AppName + ".lnk"));
            var startDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", InstallerConstants.AppName);
            TryDelete(Path.Combine(startDir, InstallerConstants.AppName + ".lnk"));
            try { if (Directory.Exists(startDir) && !Directory.EnumerateFileSystemEntries(startDir).Any()) Directory.Delete(startDir); } catch { }
        }

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }
    }
}
