# Scripting 组件合集

一个组件一个目录，集中收录适用于 iOS [Scripting](https://scriptingapp.github.io/) 的脚本和小组件。

## 组件列表

| 组件 | 功能 | 目录 |
| --- | --- | --- |
| **RefreshSideStore** | SideStore / LC+SS 签名到期倒计时；支持 RPP 只读扫描、已安装应用过滤、小号/中号桌面小组件、快捷指令刷新 | [RefreshSideStore](./RefreshSideStore/) |

## 安装

1. 进入需要的组件目录，阅读对应的 `README.md`。
2. 下载该目录中的 `.scripting` 文件，在 iPhone 的“文件”中使用 **Scripting** 打开并导入。
3. 根据组件说明配置权限、快捷指令或小组件。

各组件相互独立，后续新增组件都采用 `组件名/README.md`、`组件名/组件名.scripting` 的组织方式。需要审阅源码时可查看组件的 `src/` 目录。

## 安全及兼容性

- 配对记录、私钥、Token、Apple ID 等私人信息请勿提交至仓库。
- 不同 Scripting 和 iOS 版本的可用 API 可能不同，安装前请查看组件说明。
- 签名到期时间及桌面刷新频率以设备实际读取结果和 iOS 系统调度为准。

## 许可证

见仓库根目录 [LICENSE](./LICENSE)。
