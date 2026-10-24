# RefreshSideStore

**SideStore 签名倒计时 / 桌面小组件（Scripting）**

通过 Scripting 在 iPhone 桌面展示 SideStore 及其他已安装自签应用的签名剩余天数。支持小号、中号两种布局，浅色/深色背景设置，并可使用快捷指令触发刷新。

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

## 快捷指令联动

组件支持通过 Scripting 的 **Run Script** 动作接收文本参数。

- **`refreshed`**：仅在快捷指令确认 SideStore 刷新成功后传入；缺少真实数据源时，按设置的有效期记录**估算**到期时间。不要在失败分支传入。
- **空参数**：尝试重新读取已有来源并请求重载小组件，不应把点击时间当作刷新成功时间。

桌面点击行为会调用小组件配置中 Shortcuts 列表的第一个动作（`shortcutIndex={0}`）。实际执行环境和刷新时机取决于 iOS 与 Scripting 版本。

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

## 兼容性

组件基于 Scripting 的 TypeScript / TSX API。RPP 扫描需要设备支持相应服务及可用的隧道连接；部分 iOS 版本或网络环境中可能不可用。请优先通过应用内运行测试，确认无误后再依赖桌面小组件。
