import { Button, Text, VStack, Widget } from "scripting"

export function ShortcutDiagnostics() {
  const count = Widget.shortcutCount ?? 0
  const actionButton = (
    <Text font={11} fontWeight="semibold" foregroundStyle="white" frame={{ width: 124, height: 30 }}
      background={{ style: "#2788C5", shape: { type: "rect", cornerRadius: 8 } }}>
      等待 App 修复
    </Text>
  )
  return <VStack spacing={5} padding={8}
    widgetBackground={{ light: "#F7F9FA", dark: "#282828" }}>
    <Text font={12} fontWeight="semibold">快捷方式诊断</Text>
    <Text font={11}>系统读到 {typeof count === "number" ? count : "未知"} 个动作</Text>
    {actionButton}
    <Text font={9} foregroundStyle="secondaryLabel">返回原组件：清空参数</Text>
  </VStack>
}
