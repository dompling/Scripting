# RefreshSideStore

**SideStore 签名倒计时 / 桌面小组件（Scripting）**

通过 Scripting 在 iPhone 桌面展示 SideStore 及其他已安装自签应用的签名剩余天数。支持小号、中号两种布局，浅色/深色背景设置，并可使用快捷指令触发刷新。

## 预览

### 桌面小组件

![RefreshSideStore 小号和中号桌面小组件预览](./assets/widget-preview.webp)

小号组件展示倒计时和证书到期时间；中号组件同时展示其他已安装自签应用的剩余天数。截图为使用效果示例，实际数值以当前设备扫描结果为准。

### 快捷指令与自动化

![刷新证书与定时更新小组件的快捷指令示例](./assets/shortcut-guide.webp)

此组件需要配合 **SideStore 刷新快捷指令**和**Scripting 运行脚本动作**才能自动同步到期信息；桌面小组件自身主要展示最后一次成功扫描的数据。

## 功能

- **真实到期时间（推荐）**：使用设备的 RPP 配对记录建立 RemotePairing / RSD 连接，通过 `misagent CopyAll` 只读查询描述文件，再结合 `installation_proxy` 当前已安装应用列表过滤，排除已经卸载的应用残留记录。
- **隧道连接**：支持设备配对（灵动岛验证码）、导入配对记录、指定反射 IP 和 RemotePairing 端口；默认反射 IP `10.7.0.1`，端口可自动探测与回退。
- **桌面展示**：小号马蹄圈；中号支持最多三个应用的名称、剩余天数与进度条；可调整应用排序。
- **外观**：支持亮色/暗色和独立底部渐变颜色选择。
- **其他来源**：根据运行时支持情况，可读取 `widget_data.json`、SideStore SQLite、`.mobileprovision`、手动到期日或快捷指令回传的估算值。

## 一键安装

### [⬇️ 点击一键安装 RefreshSideStore](https://www.scripting.fun/import_scripts/?urls=%5B%22https%3A%2F%2Fraw.githubusercontent.com%2Fdompling%2FScripting%2Fmain%2Fdist%2FRefreshSideStore.zip%22%5D)

请在 **iPhone / iPad 的 Safari** 中打开上述链接，进入 Scripting 导入页面。发布文件：[RefreshSideStore.zip](../dist/RefreshSideStore.zip)。

> 也可以手动下载 [RefreshSideStore.scripting](./RefreshSideStore.scripting)，通过文件共享面板选择 Scripting 导入；这两个包的组件内容一致。

## 首次设置

1. 完成导入后，在 Scripting 中打开 **RefreshSideStore**，根据需要设置数据来源或配对记录。
2. 添加 **Scripting 桌面小组件**，绑定此组件；在小组件 Shortcuts 动作列表中将所需快捷指令放在第一位。
3. 若使用 RPP 读取：在组件设置中通过灵动岛验证码配对，或导入现有配对记录；使用合适的反射地址（例如 Surge 的 `10.7.0.1`）进行只读扫描。

**更新说明：** 一键安装链接指向仓库 `main` 分支最新发布的 ZIP；更新后可重新点击安装，实际是否提示覆盖或重新导入，以 Scripting 的行为为准。本组件目前没有启用后台自动更新。

> **注意**：能通过隧道访问端点，不等于 RPP 配对、RSD 服务发现和 misagent 读取一定成功。桌面小组件也受 iOS 后台运行时间及刷新调度限制，无法保证每次都能在后台完整扫描。

## 搭配快捷指令使用（建议配置）

上面的截图分别展示了 **「刷新证书」** 与 **「更新小组件」** 两个快捷指令。建议分开配置：第一个负责真实续签，第二个负责更新签名有效期缓存。

### ①「刷新证书」——续签成功后同步小组件

1. 在 iOS「快捷指令」中新建快捷指令，命名为 **刷新证书**。
2. 添加「获取无线局域网网络的名称」，使用「如果名称有任何值」判断是否已连接 Wi-Fi；没连上时先提醒连接，再决定是否继续。
3. 在 Wi-Fi 条件满足的分支执行 SideStore 的 **Refresh All Apps**，按需求设置「包含今天到期」。
4. **仅确认 SideStore 刷新成功后**显示成功通知，随后添加 **Scripting → 运行脚本（Run Script）→ RefreshSideStore**，让脚本重新扫描当前已安装应用及证书期限。
5. 首次运行需要先在组件内完成 RPP 设备配对，并确认网络反射/隧道能够连接到本机 RSD 服务。

> SideStore 执行「刷新所有应用」和 Scripting 执行「读取证书到期时间」是两个操作。后者只读取系统数据，**不会替 SideStore 续签**。不要在刷新失败的分支显示成功通知。

### ②「更新小组件」——定时同步扫描结果

1. 新建名为 **更新小组件** 的快捷指令，添加 **Scripting → 运行脚本 → RefreshSideStore**；一般无需传参数。
2. 到「快捷指令 → 自动化」创建定时触发：例如 **00:00**、**12:00**。
3. 可按需再建「连接或断开电源」自动化，运行相同的「更新小组件」快捷指令。
4. Scripting 通过 RPP 读取描述文件并过滤系统当前已安装的 App，成功后写入缓存并请求重载桌面小组件。

> 定时触发频率和后台执行能力受 iOS/Scripting 限制，无法保证每次都能在后台完成 RPP 扫描。失败时不会用猜测的时间覆盖上次正确结果。

### 桌面小组件点击触发「扫描自签」

如果你在 SideStore 或 LiveContainer 中手动刷新了 App 签名，也可以直接在桌面点击小组件立即触发同步：

1. 在桌面长按 **RefreshSideStore** 小组件，选择 **「编辑小组件」**；
2. 将 **「点击后」** 设置为 **`运行脚本（单实例）`**；
3. 将 **「参数」** 填写为 **`scan`**（或 **`扫描自签`**）；
4. 保存后，在桌面上点击该小组件，脚本将通过温和触觉反馈在后台完成 RPP 隧道扫描并静默刷新小组件数据！

> **提示**：该扫描操作仅在 Wi-Fi 局域网隧道可用时生效；若未连接 Wi-Fi，系统会自动弹出贴心提示。

### 扫描自签与 Wi-Fi 提示

在组件设置页点击 **「扫描自签」** 时，会先读取网络状态。若当前网络路径未检测到 Wi-Fi，会显示提醒，建议连接 Wi-Fi 并检查 Surge 隧道/设备反射地址。提示仅供排查，不强行阻断扫描——VPN 可能隐藏底层 Wi-Fi 路径，而且最终能否读取仍取决于 RPP/RSD 连接。网络状态 API 不可用时按原流程继续扫描。

## 目录

```text
RefreshSideStore/
├── README.md                     # 当前使用说明
├── RefreshSideStore.scripting    # 手动导入的组件包
└── src/                          # 组件原始 TypeScript/TSX 源码
    ├── index.tsx
    ├── widget.tsx
    ├── script.json
    ├── rpp-expiry.ts
    └── lib/
```

## 说明与隐私

- 配对记录包含设备敏感凭据，**仅在本机保存**，不要提交 `.mobiledevicepairing`、`.plist` 配对文件或任何私钥。
- RPP 查询仅用于读取应用安装信息和签名描述文件；**不执行安装、卸载或续签**。
- 通过快捷指令回传的时间可能是估算值，不等同于从系统描述文件读取的真实到期时间。
- `src/` 包含从组件包导出的源码，方便审阅、修改与提交 Issue。

## 版本与更新

- 当前组件版本以 [src/script.json](./src/script.json) 的 `version` 为准，按语义化版本号维护：修复用补丁号、功能用次版本号、不兼容改动用主版本号。
- 提交 `src/` 中的代码到 `main` 后，GitHub Actions 自动重新生成 [dist/RefreshSideStore.zip](../dist/RefreshSideStore.zip) 和 [RefreshSideStore.scripting](./RefreshSideStore.scripting)，一键安装链接不变，指向最新版文件。
- **自动打包不等于自动升级已安装脚本**：`remoteResource` 目前未配置。已安装用户需要重新打开一键安装链接获取新版本。
- 不需要为了编辑 README 而修改版本号。

## 兼容性

组件基于 Scripting 的 TypeScript / TSX API。RPP 扫描需要设备支持相应服务及可用的隧道连接；部分 iOS 版本或网络环境中可能不可用。请优先通过应用内运行测试，确认无误后再依赖桌面小组件。
