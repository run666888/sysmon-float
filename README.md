# 系统状态悬浮窗

面向 Windows 11 的 Electron 桌面悬浮窗，显示 CPU、网络、GPU、内存和系统运行时间。窗口支持纵向与横向布局、三种密度、四种配色、透明度、置顶和托盘操作。

## 启动

双击 `启动.bat`，或在项目目录运行：

```powershell
npm install
npm start
```

`npm run dev` 会另外打开开发者工具。压缩包已包含 `node_modules`；如果依赖完整，`启动.bat` 不会重复安装。此项目尚未制作安装包。

## 玻璃效果

Windows 没有 Apple 的原生 Liquid Glass 材质。本项目使用真正透明的圆角窗口：普通配色显示前由 Electron 取得一张干净桌面底图，缩小后连续柔化，再由 WebGL 按圆角矩形边缘绘制折射。“透”配色中心是真正透明的实时桌面，边缘从低分辨率连续屏幕视频中只取窗外邻近区域，避免拍到悬浮窗自身；CSS 不绘制额外高光。文字颜色会随背景明暗调整。视频流不可用时，边缘退回到 500ms 一次的截图采样。

此电脑上的 Windows Acrylic 会在圆角外露出矩形材质，因此当前版本不使用它。普通配色拖动时折射采样位置会跟随窗口移动，后方内容变化时底图要在下次隐藏并显示时刷新。“透”配色显示期间会采样窗外像素更新边缘，中心始终直接透出当前桌面。桌面视频只在本机用于渲染，不会上传。采集失败时仍显示可读的半透明样式。详见 [验收报告](验收报告.md)。

边缘几何与轻量着色器的思路参考 [WeChat-LiquidGlass](https://github.com/liuran001/WeChat-LiquidGlass)。“透”配色现在让卡片中心完全透出实时桌面，圆角边缘保留柔化与折射；拖动时中心会随真实背景变化。它在文字复杂的背景上可能降低可读性。WeChat 项目运行在 Android/微信内部，能直接采样应用页面；这里不能直接复用其 AGSL 管线。

已接入 Windows 原生实时折射组件 `@hicccc77/electron-liquid-glass` 作为实验路径。本机 Intel Arc 130T + 200% 缩放环境中，组件能创建并绘制面板，但其桌面采样在悬浮窗下呈黑色；Windows Acrylic 又会在圆角外露出矩形材质。因此两者**未作为默认效果启用**。若在其他机器上自行验证原生路径，可设置环境变量 `SYSMON_NATIVE_GLASS=1` 后启动；这条路径不保证可用。当前默认效果是可运行的“实时透明中心 + 截图折射边缘”，并非 Apple 的完整实时 Liquid Glass。

数字按钮显示色垫透明度，依次切换 0%、25%、50%、75%、100%。**100% 会完全移除颜色层**，保留圆角边缘的柔化与折射和数据。此前配置文件的 `opacity` 字段仍作为内部色垫强度保存，因此原值 55 对应界面显示 45% 色垫透明度。

## 操作

| 操作 | 作用 |
| --- | --- |
| 拖动标题栏 | 移动悬浮窗，位置会保存 |
| 标 / 简 / 详 | 切换标准、极简、详细模式；详细模式显示累计流量和 TUN 数据 |
| 竖 / 横 | 切换纵向或横向布局 |
| 夜 / 灰 / 海 / 透 | 切换玻璃配色；“透”的中央透出更多背景 |
| 数字按钮 | 切换色垫透明度，最高 100% 无色玻璃 |
| 图钉 | 切换置顶 |
| × | 隐藏到托盘 |
| 托盘左键 | 显示或隐藏窗口 |
| 托盘右键 | 置顶、开机启动、退出 |

## 数据来源

| 数据 | 来源 | 常规刷新 |
| --- | --- | --- |
| CPU 负载 | `systeminformation.currentLoad()` | 1 秒 |
| CPU 频率 | `systeminformation.cpuCurrentSpeed()` | 3 秒 |
| CPU 温度 | `systeminformation.cpuTemperature()`，必要时尝试 WMI | 15 秒 |
| 网络速率与本次累计流量 | 对已连接的物理网卡调用 `systeminformation.networkStats(网卡名)` | 1 秒 |
| 网络延迟 | 对 `1.1.1.1` 的单次 ping；ping 失败不等于网卡离线 | 10 秒 |
| GPU 利用率 | NVIDIA 优先用 `nvidia-smi`，其他显卡用 Windows GPU 性能计数器 | 5 秒 |
| GPU 型号 | `systeminformation.graphics()`，跳过虚拟显示设备 | 启动时 |
| 内存 | `systeminformation.mem()` | 2 秒 |
| 系统运行时间 | `systeminformation.time()` | 10 秒 |

本机识别到的物理网卡为 WLAN，显卡为 Intel Arc 130T。集显显存数据如果只有一个不可靠的“总量”，界面会隐藏该数字。项目目前没有电池和磁盘监控。

## 文件

```text
main.js                 窗口、托盘、配置、桌面截图及实验性原生玻璃
preload.js              主进程与界面的受限通信桥
src/collect.js          系统指标采集
src/capture.ps1         旧版截图脚本，当前启动流程不再使用
renderer/index.html     面板结构
renderer/style.css      玻璃表面和布局
renderer/refract.js     WebGL 透镜与散射
renderer/renderer.js    数值、图表和交互
```

配置保存在 Electron 的 `userData/settings.json`。修改刷新频率可编辑 `src/collect.js` 中的 `JOBS`。`src/capture.ps1` 是旧版遗留脚本，当前启动与打包均不依赖它。

## 开发与打包

```bash
npm install
npm start        # 开发运行
```

Windows 打包可自行接入 electron-builder。

## License

MIT
