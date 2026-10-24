# RefreshSideStore

**SideStore 签名倒计时 / 桌面小组件（Scripting）**

通过 Scripting 在 iPhone 桌面展示 SideStore 及其他已安装自签应用的签名剩余天数。支持小号、中号两种布局，浅色/深色背景设置，并可使用快捷指令触发刷新。

## 功能

- **真实到期时间（推荐）**：使用设备的 RPP 配对记录建立 RemotePairing / RSD 连接，通过 `misagent CopyAll` 只读查询描述文件，再结合 `installation_proxy` 当前已安装应用列表过滤，排除已经卸载的应用残留记录。
- **隧道连接**：支持设备配对（灵动岛验证码）、导入配对记录、指定反射 IP 和 RemotePairing 端口；默认反射 IP `10.7.0.1`，端口可自动探测与回退。
- **桌面展示**：小号马蹄圈；中号支持最多三个应用的名称、剩余天数与进度条；可调整应用排序。
- **外观**：支持亮色/暗色和独立底部渐变颜色选择。
- **其他来源**：根据运行时支持情况，可读取 `widget_data.json`、SideStore SQLite、`.mobileprovision`、手动到期日或快捷指令回传的估算值。

## 安装方法

1. 下载 [RefreshSideStore.scripting](./RefreshSideStore.scripting)。
2. 传到 iPhone，使用 **Scripting** 打开并导入。
3. 进入 Scripting 运行 **RefreshSideStore**，按需完成配对或数据来源设置。
4. 添加 **Scripting 桌面小组件**，绑定此组件；在小组件 Shortcuts 动作列表中将所需快捷指令放在第一位。
5. 若使用 RPP 读取：在组件设置中通过灵动岛验证码配对，或导入现有配对记录；使用合适的反射地址（例如 Surge 的 `10.7.0.1`）进行只读扫描。

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
├── RefreshSideStore.scripting    # 可直接导入 Scripting 的组件包
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
