# Scripting 组件合集

一个组件一个目录，集中收录适用于 iOS [Scripting](https://scriptingapp.github.io/) 的脚本和小组件。

## 组件列表

| 组件 | 功能 | 版本 | 目录 | 安装 |
| --- | --- | --- | --- | --- |
| **RefreshSideStore** | SideStore / LC+SS 签名到期倒计时；支持 RPP 只读扫描、已安装应用过滤、小号/中号桌面小组件、快捷指令刷新 | `1.0.1` | [RefreshSideStore](./RefreshSideStore/) | [⬇️ 一键安装](https://www.scripting.fun/import_scripts/?urls=%5B%22https%3A%2F%2Fraw.githubusercontent.com%2Fdompling%2FScripting%2Fmain%2Fdist%2FRefreshSideStore.zip%22%5D) |

## 安装

**推荐：**在 iPhone / iPad 的 **Safari** 中点击组件列表里的「⬇️ 一键安装」，会打开 Scripting 导入页面并导入脚本。安装后，按组件 README 完成首次配置。

也可以手动下载对应目录里的 `.scripting` 文件，用 Scripting 打开并导入。所有一键安装发布包统一放在 [dist/](./dist/) 目录。

一键导入地址遵循以下格式（`urls` 为 URL 编码的 JSON 数组，可包含多个 ZIP）：

```text
https://www.scripting.fun/import_scripts/?urls=<URL 编码后的 ZIP 地址数组>
```

**RefreshSideStore 发布包：** [dist/RefreshSideStore.zip](./dist/RefreshSideStore.zip)。

各组件相互独立，后续新增组件都采用 `组件名/README.md`、`组件名/组件名.scripting` 的组织方式。需要审阅源码时可查看组件的 `src/` 目录。

## 预览及快捷指令

![RefreshSideStore 桌面小组件预览](./RefreshSideStore/assets/widget-preview.webp)

配套快捷指令「刷新证书」「更新小组件」及自动化配置说明请查看 [RefreshSideStore README](./RefreshSideStore/README.md#搭配快捷指令使用建议配置)。上面的截图是外观示例，具体剩余天数以设备签名记录为准。

## 版本及发布

各组件的版本号维护在自己的 `组件名/src/script.json` 里，采用 `主版本.次版本.补丁` 格式。新功能、修复发布时手动更新版本号；提交组件 `src/` 后，GitHub Actions 会自动重建 `dist/<组件名>.zip` 和 `组件名/<组件名>.scripting`，覆盖旧安装包。**打包是自动的，但用户已安装脚本不会自动升级**，需再次点击一键安装链接。

## 安全及兼容性

- 配对记录、私钥、Token、Apple ID 等私人信息请勿提交至仓库。
- 不同 Scripting 和 iOS 版本的可用 API 可能不同，安装前请查看组件说明。
- 签名到期时间及桌面刷新频率以设备实际读取结果和 iOS 系统调度为准。

## 许可证

见仓库根目录 [LICENSE](./LICENSE)。
