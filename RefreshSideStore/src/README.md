# SideStoreWidget

## 背景与中号布局（2026-10-23）

当前项目名为 `RefreshSideStore`。运行脚本后，在“底部背景渐变”中通过系统颜色选择器分别选择明亮 / 暗黑模式的底部渐变色。选色后自动保存并请求刷新小组件，无需保存按钮，也可恢复默认。上半部分底色固定为明亮 `#F7F9FA` / 暗黑 `#282828`，选色只影响下半部分。已有保存的颜色会继续用于对应模式的底部渐变。原生选色器的 RGB / RGBA 返回值会转换后参与渐变计算；主屏更新时间仍由 iOS 决定。

背景顶部 55% 保持模式底色，下面 45% 垂直渐变到底部。底部颜色由模式底色与所选颜色按 76% / 24% 混合，避免整块变成所选颜色；恢复默认时底部只轻微压暗。渐变延伸至到期信息圆角框背后，框内保留半透明底色。更新时间相对标题上移 2pt。

中号保留左侧马蹄圈，右侧按可用宽度展示最多三个应用的名称、剩余天数及进度条；设置页增加独立的小号 / 中号预览入口。当前外观改动已通过本地声明的严格类型检查及颜色、设置兼容、布局边界检查；`SideStoreWidget-appearance-preview.png` 是实际 TSX 视图树的近似布局预览，iOS 主屏渲染仍需真机确认。

以下为早期安装及数据源说明；以当前设置页和运行时代码支持的功能为准。

## RPP 实际到期时间读取（2026-10-23）

设置页新增“**通过 RPP 读取实际到期时间**”：它迁移自 `RPP App Expiry Reader` 的只读流程，使用已保存的 RPP 配对记录建立 RSD 隧道，调用 `misagent CopyAll` 读取描述文件，并用 `installation_proxy` 当前安装清单精确过滤。因此不会把卸载应用遗留的旧描述文件当作有效 App。

- 首次可直接在 RefreshSideStore 设置页点击“设备配对（灵动岛验证码）”；按灵动岛显示的六码在 iOS「设置 → 隐私与安全性 → 开发者模式 → 配对设备」完成配对。
- 在“设备反射 IP”填写外部 VPN/Surge 的反射地址，默认 `10.7.0.1`。
- 成功后，结果会直接成为小组件唯一的数据源；不再需要目录授权、`widget_data.json` 或 SQLite 文件。


Scripting 主屏小组件。按参考图制作马蹄圈、白色指示点、签名剩余天数、到期时间，支持浅色 / 深色、小号 / 中号。小号、中号整块内容均为无额外样式的系统快捷指令按钮，运行主屏小组件 Shortcuts 列表中的第一个动作（`shortcutIndex={0}`）。

## 安装

1. 将 `SideStoreWidget.scripting` 传到 iPhone，在“文件”中选择使用 **Scripting** 打开并导入。也提供标准 ZIP 源码备份。如果当前版本没有接管 `.scripting` 文件，可解压 ZIP，在 Scripting 新建项目，将目录内源码文件放进同一项目。
2. 在 Scripting 内运行 `SideStoreWidget`，完成设置。首次文件系统授权用于读取你选择的本地文件。脚本不发网络请求、不上传文件、不写入 SideStore 数据。
3. 设置倒计时来源，或按下文给 `RefreshSideStore` 添加回传步骤。
4. 主屏添加 Scripting 小组件，选择本项目。小号接近参考图；中号增加数据来源、续签时间和点击行为说明。
5. 在 Scripting 内运行 `RefreshSideStore` 完成数据配置；长按主屏小组件 → 编辑小组件 → Shortcuts，添加刷新快捷指令并放在第一个。

## 快速可用：刷新成功后回传估算

你的快捷指令名称已设为 **RefreshSideStore**。

在快捷指令中找到**确认 SideStore 刷新成功**的分支，在末尾添加：

1. 添加一个“文本”动作，内容只有 `refreshed`。
2. 添加 Scripting 的“运行脚本 / Run Script”动作，选择 `SideStoreWidget`。
3. 将上一步文本作为参数传给该动作。

如动作有输入类型设置，选择文本。不要把回传放在刷新之前或失败分支；打开客户端、开始刷新都不等于刷新成功。脚本无法自行验证调用方所称的成功。

当没有配置真实数据源时，回传记录时间并计算：

```
估算到期时间 = 回传时刻 + 设置的有效期（默认 7 天）
```

小组件明确显示 **“签名倒计时 · 估算”**。设置中可选 7 / 365 天，应以实际账号、签名有效期为准。手动到期时间会被这个明确的回传切换为估算；已有真实数据源则只重新读取该源，**不会被回传覆盖为估算**。

留空参数调用本项目时，只重新读取已有数据并请求刷新小组件，不会把点击时间当成续签时间。返回 JSON 包含 `ok`、`estimated`、`expiresAt`、`message`。

## 真实数据来源

| 数据 | 接入方式 | 更新边界 |
| --- | --- | --- |
| `widget_data.json` | 授权包含该文件的目录，脚本保存相对路径并直接读取 | 原文件更新后，下次读取能跟随；导出的副本需再次更新 |
| `Database/SideStore.sqlite`，旧版 `AltStore.sqlite` | 优先授权所在目录，运行时验证表结构并只读查询 | 必须同时能访问 SQLite WAL；仅复制主文件可能得到旧数据 |
| `.mobileprovision` | 选择描述文件 | 读取 CreationDate / ExpirationDate；静态副本不会跟随续签 |
| 手动到期时间 | 设置页日期选择器 | 需要自行更新，显示“手动” |

多应用数据必须选择倒计时对象，不会悄悄取另一个应用的最早到期时间。设置目录时会在授权目录的有限层级内查找 widget_data.json，找到后保存相对文件路径；小组件每次直接通过目录授权读取该文件。

当前 SideStore 官方导出结构如下。**数字日期是 2001-01-01 UTC 起的秒数，不是 Unix 秒或毫秒**：

```json
{
  "activeApps": [
    {
      "name": "SideStore",
      "bundleIdentifier": "example.identifier",
      "expirationDate": 814658220,
      "refreshedDate": 814053420
    }
  ],
  "allApps": [],
  "lastUpdated": 814053420
}
```

此 JSON 仅说明结构，不包含可用于你的设备的真实数据。

## 关于你提供的 Cookies 路径

你指出的：

```
LiveContainer/SideStore/Library/Cookies/Cookies.binarycookies
```

符合二合一 SideStore 的 HOME 目录结构，但**没有证据表明其中的 Cookie 过期时间代表应用签名到期时间**。当前官方源码将 InstalledApp 的到期时间设为描述文件的 ExpirationDate，未找到写入 Cookie 的签名状态协议。

另一个限制是：当前二合一版本的 widget JSON / 数据库通常位于**真实 iOS App Group**，并不一定在“文件”可见的 LiveContainer 文稿目录中。选择 LiveContainer 目录不能保证读到它，Scripting 也不能凭路径绕过 iOS 沙盒。

因此，脚本不会把 Cookie 当成签名数据。设置页的“诊断 Cookies.binarycookies”只在本地解析域名和名称，不解码或保存 Cookie 值。找不到真实签名数据时，可选择手动或快捷指令回传估算。

## 小组件刷新按钮（iOS 27+）

小号、中号整块内容由 `Button shortcutIndex={0}` 承载，保持现有布局和背景。点击时由系统执行该小组件 Shortcuts 列表的第一个动作；不再通过 `widgetURL`、项目入口或 `shortcuts://run-shortcut` 转跳运行快捷指令，设置页也不再填写快捷指令名称。

1. 长按主屏上的 Scripting 小组件，选择“编辑小组件”。
2. 在 Shortcuts 中添加刷新快捷指令，将其排在第一个。
3. 返回主屏，点击组件执行。

API 索引从 **0** 开始，第一个动作是 `shortcutIndex={0}`，`1` 是第二个。重排或删除列表条目会改变绑定到的动作。旧测试小组件如使用四槽位配置，需要按新列表重新配置。

需要支持此 API 的 Scripting 3.2.2 TestFlight 和 iOS 27+。应用内预览只能检查布局，不能配置或执行这些动作；未配置或系统不支持时只显示按钮内容，不执行旧 URL 跳转。某些系统动作仍可能由系统打开“快捷指令”应用。执行动作不等于签名已刷新成功。

[官方接口说明](https://scriptingapp.github.io/TestFlight/zh/guide/Changelog/3.2.2/Breaking%20Change%3A%20Widget%20Shortcut%20Lists#12-%E5%9C%A8%E5%B0%8F%E7%BB%84%E4%BB%B6%E6%8C%89%E9%92%AE%E4%B8%AD%E8%BF%90%E8%A1%8C%E7%B3%BB%E7%BB%9F%E5%BF%AB%E6%8D%B7%E6%8C%87%E4%BB%A4ios-27)

## 显示与刷新

点击无响应时，可在主屏“编辑小组件”的“参数”中填入 `debug-shortcut`，退出编辑后测试。当前诊断入口按用户建议做单按钮实验：仅保留 `shortcutIndex={0}`，设置 `buttonStyle="none"`，标签使用自定义圆角背景；第二个系统按钮和本地 AppIntent 计数按钮已暂时注释，不参与渲染。当前同步声明的 `ButtonStyle` 不含 `none`，因此仅在这一个诊断按钮上使用有说明的 `@ts-expect-error`，让手机实测决定其运行时行为；倒计时主视图的样式保持原实现。测试后清空参数恢复倒计时。

- 马蹄圈从左侧红色到右侧绿色，白点表示剩余有效期占满量程的比例。
- 大数字保留一位小数并向下取整，少于一天显示 `<1 天`，到期显示 `0 天`。
- 右上角表示**最近数据读取时间**。快捷指令估算模式显示回传时间；手动模式显示横线。
- 数据读取失败时保留上次成功的数据，标明“缓存”。中号和设置页提供错误说明；缓存不会被伪造为新一次读取。
- 时间均按手机当地时区显示。
- 请求约 15 分钟后重新生成时间线；实际时间由 iOS 决定。图形和小数不是每秒实时更新。
- 如需保留参考图的彩色渐变，应使用系统小组件的全彩显示；iOS 着色模式可能将其改为单色。

## 文件

- `index.tsx`：设置、数据目录授权、JSON 读取、预览和点击路由。
- `widget.tsx`：一次性读取数据并提交小组件视图。
- `view.tsx`：小号马蹄圈及中号布局；纯矢量，无远程图片依赖。
- `runtime.ts`：本地配置、持久书签、真实数据读取、缓存、估算状态。
- `model.ts`：日期换算、应用选择、倒计时、描述文件读取。
- `cookies.ts`：仅用于诊断的 binarycookies 元数据解析。
- `intent.tsx`：快捷指令回传与刷新入口，每条分支返回结果并结束脚本。
- `script.json`：项目元数据。

没有新增第三方依赖。小组件 UI 使用 Scripting 原生组件和系统快捷指令按钮，没有定时轮询、后台保活或外部服务。

## 验证范围

已使用本机 Scripting App 自带 TypeScript 声明做严格类型检查；15 项逻辑测试通过，覆盖 Apple 日期、到期边界、多应用选择、Cookie 二进制越界与值保护、只读 SQLite 配置、缓存、真实快捷指令入口的回传行为。

`SideStoreWidget-preview.png` 是由实际 TSX 视图树生成的**开发布局预览**，使用示例数据，SVG 渲染近似了原生字体、图标及角向渐变，**不是真机截图**。本机 Scripting 自动预览连接超时，未完成原生运行验证。

尚需在你的 iPhone 上确认：导入、主屏小号 / 中号尺寸与渐变、点击唤起 RefreshSideStore、刷新成功后的回传、外部文件书签能否在 Widget 扩展中访问。真实数据解析尚未用你的 SideStore 文件验证。

## 源码依据

- [InstalledApp 到期时间来自 provisioning profile](https://github.com/LiveContainer/SideStore/blob/ee3cc16a67f9fed766f79a0ed70938f0f8ad5a07/AltStore/Core/Model/InstalledApp.swift#L266-L315)
- [SideStore widget_data.json 的写入与路径](https://github.com/LiveContainer/SideStore/blob/ee3cc16a67f9fed766f79a0ed70938f0f8ad5a07/SideStore/Widget/WidgetData/WidgetDataManager.swift#L20-L30)
- [Widget JSON 字段](https://github.com/LiveContainer/SideStore/blob/ee3cc16a67f9fed766f79a0ed70938f0f8ad5a07/SideStore/Widget/WidgetData/WidgetModels.swift#L16-L41)
- [SideStore 真实数据库目录](https://github.com/LiveContainer/SideStore/blob/ee3cc16a67f9fed766f79a0ed70938f0f8ad5a07/AltStore/Core/Model/DatabaseManager/PersistentContainer.swift#L77-L88)
- [二合一 HOME 位置](https://github.com/LiveContainer/LiveContainer/blob/9108ae624ea001f7d7696d48407f890b48fa2653/LiveContainer/LCBootstrap.m#L420-L425)
- [二合一 AppGroup hook](https://github.com/LiveContainer/LiveContainer/blob/9108ae624ea001f7d7696d48407f890b48fa2653/SideStoreSupport/SideStoreHooks.m#L78-L83)
- [二合一 sidestore scheme 路由](https://github.com/LiveContainer/LiveContainer/blob/9108ae624ea001f7d7696d48407f890b48fa2653/LiveContainerSwiftUI/Views/AppList/LCAppListView.swift#L1194-L1197)
- [二合一专用 SideStore URL](https://github.com/LiveContainer/LiveContainer/blob/9108ae624ea001f7d7696d48407f890b48fa2653/ShareExtension/ShareExtensionViewModel.swift#L503-L507)
