import { Button, Circle, GeometryReader, HStack, Image, PathShape, Spacer, Text, VStack, ZStack } from "scripting"
import { countdown, shortDate, shortTime } from "./model"
import { Settings, WidgetState } from "./runtime"
import { backgroundGradient, DEFAULT_BACKGROUNDS } from "./appearance"

function pointColor(progress: number): any {
  if (progress < 0.18) return "#B82020"
  if (progress < 0.38) return "#F08A1D"
  if (progress < 0.60) return "#F5D627"
  if (progress < 0.80) return "#89C853"
  return "#26A67A"
}

function colorWithAlpha(hex: string, alpha: number): any {
  const value = hex.slice(1)
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

function ProgressBlocks({ expiresAt, now, totalDays, width }: { expiresAt: number; now: number; totalDays: number; width: number }) {
  const progress = countdown(expiresAt, now, totalDays).progress
  const color = pointColor(progress)
  const filled = Math.max(0, Math.min(10, Math.round(progress * 10)))
  return <HStack spacing={3} frame={{ width, height: 6 }}>
    {Array.from({ length: 10 }, (_, index) => <Text font={1} frame={{ width: Math.max(0, (width - 27) / 10), height: 5 }}
      background={{ style: index < filled ? color : "rgba(127,127,127,0.18)", shape: { type: "rect", cornerRadius: 2.5 } }}> </Text>)}
  </HStack>
}

function Logo({ size }: { size: number }) {
  return <PathShape
    frame={{ width: size, height: size }}
    stroke={{ shapeStyle: "#2788C5", strokeStyle: { lineWidth: size * 0.13, lineCap: "round", lineJoin: "round" } }}
    draw={(path, s) => {
      const point = (x: number, y: number) => ({ x: x * s.width, y: y * s.height })
      path.move(point(0.48, 0.08))
      path.addLine(point(0.48, 0.24)).addLine(point(0.24, 0.24))
      path.addCurve(point(0.24, 0.57), point(0.04, 0.24), point(0.04, 0.57))
      path.addLine(point(0.47, 0.57)).addLine(point(0.47, 0.93))
      path.move(point(0.27, 0.41)).addLine(point(0.92, 0.41))
      path.move(point(0.67, 0.61)).addLine(point(0.67, 0.93))
      path.move(point(0.37, 0.15)).addLine(point(0.48, 0.04)).addLine(point(0.58, 0.15))
    }}
  />
}

export function Dial({ state, settings, now, size = 160, showRefreshTime = true }: {
  state: WidgetState; settings: Settings; now: number; size?: number; showRefreshTime?: boolean
}) {
  const scale = size / 160
  const p = (n: number) => n * scale
  const app = state.snapshot?.app
  const value = countdown(app?.expiresAt, now, settings.totalDays)
  const angle = (160 + 220 * value.progress) * Math.PI / 180
  const point = { x: p(80 + 55 * Math.cos(angle)), y: p(94 + 55 * Math.sin(angle)) }
  const markerColor = pointColor(value.progress)
  const status = "证书倒计时/天"

  return <ZStack frame={{ width: size, height: size }}>
    <HStack spacing={p(4)} frame={{ width: p(136), height: p(18) }} position={{ x: p(80), y: p(18) }}>
      <Logo size={p(14)} />
      <Text font={p(12)} fontWeight="bold" foregroundStyle="label" lineLimit={1}>SideStore</Text>
      <Spacer minLength={0} />
      {showRefreshTime ? <HStack spacing={p(3)} alignment="center" offset={{ x: 0, y: -2 }}>
        <Image systemName="arrow.trianglehead.2.clockwise.rotate.90" font={p(8.5)} foregroundStyle="secondaryLabel" />
        <Text font={p(10)} fontWeight="medium" foregroundStyle="secondaryLabel">{shortTime(now)}</Text>
      </HStack> : null}
    </HStack>
    <PathShape
      frame={{ width: size, height: size }}
      stroke={{
        shapeStyle: app ? { colors: ["#B82020", "#F08A1D", "#F5D627", "#F5D627", "#89C853", "#26A67A"], center: { x: 0.5, y: 94 / 160 }, startAngle: { type: "degrees", value: 160 }, endAngle: { type: "degrees", value: 380 } } : "tertiaryLabel",
        strokeStyle: { lineWidth: p(10), lineCap: "round" },
      }}
      draw={path => path.addRelativeArc({ center: { x: p(80), y: p(94) }, radius: p(55), startAngle: 160 * Math.PI / 180, delta: 220 * Math.PI / 180 })}
    />
    {app ? <ZStack frame={{ width: p(24), height: p(24) }} position={point}>
      <Circle fill={colorWithAlpha(markerColor, 0.20)} frame={{ width: p(22), height: p(22) }} />
      <Circle fill={colorWithAlpha(markerColor, 0.40)} frame={{ width: p(16), height: p(16) }} />
      <Circle fill={markerColor} frame={{ width: p(9.5), height: p(9.5) }} shadow={{ color: colorWithAlpha(markerColor, 0.65), radius: p(3) }} />
      <Circle fill="white" frame={{ width: p(6.8), height: p(6.8) }} shadow={{ color: "rgba(255,255,255,0.95)", radius: p(1.5) }} />
    </ZStack> : null}
    <Text font={p(9)} fontWeight="semibold" foregroundStyle={value.expired ? "systemRed" : "secondaryLabel"}
      frame={{ width: p(70), height: p(16) }}
      background={{
        style: colorWithAlpha(markerColor, 0.10),
        shape: "capsule",
      }}
      position={{ x: p(80), y: p(70) }}
    >{status}</Text>
    <Text font={p(36)} fontWeight="bold" fontDesign="rounded" foregroundStyle="label"
      position={{ x: p(80), y: p(99) }}>{value.text}</Text>
    <HStack spacing={p(4)} frame={{ width: p(114), height: p(24) }}
      background={{
        style: colorWithAlpha(markerColor, 0.10),
        shape: "capsule",
      }}
      position={{ x: p(80), y: p(140) }}>
      <Image systemName="clock.fill" foregroundStyle={value.expired ? "systemRed" : markerColor} font={p(11)} />
      <Text font={p(10.5)} fontWeight="semibold" foregroundStyle="label" lineLimit={1}>
        {app ? `到期: ${shortDate(app.expiresAt)}` : "请先打开脚本配置"}
      </Text>
    </HStack>
  </ZStack>
}

export function WidgetView({ state, settings, now, medium = false }: {
  state: WidgetState; settings: Settings; now: number; medium?: boolean
}) {
  const app = state.snapshot?.app
  const apps = state.apps ?? (app ? [app] : [])
  return <GeometryReader
    widgetBackground={{
      light: backgroundGradient(settings.lightBackground, DEFAULT_BACKGROUNDS.light),
      dark: backgroundGradient(settings.darkBackground, DEFAULT_BACKGROUNDS.dark),
    }}>
    {geometry => {
      const size = Math.min(geometry.size.height, medium ? geometry.size.width * 0.46 : geometry.size.width)
      const gap = medium ? 8 : 0
      const rightWidth = medium ? Math.max(0, geometry.size.width - size - gap - 12) : 0
      const visibleApps = apps.slice(0, 3)
      const scale = size / 160
      const rowHeight = Math.min(38 * scale, (size - 40 * scale) / Math.max(1, visibleApps.length))
      const listTop = (size - rowHeight * visibleApps.length) / 2 + 8 * scale
      // Do not wrap in Button shortcutIndex until the app fix lands.
      return <HStack spacing={gap} contentShape={{ type: "rect", cornerRadius: 0 }} frame={{ width: geometry.size.width, height: geometry.size.height, alignment: medium ? "leading" : "center" }}>
        <Dial state={state} settings={settings} now={now} size={size} showRefreshTime={!medium} />
        {medium ? <ZStack frame={{ width: rightWidth, height: size }}>
          <HStack spacing={3} alignment="center" frame={{ width: rightWidth, height: 18 * scale }}
            position={{ x: rightWidth / 2, y: 18 * scale - 2 }}>
            <Spacer minLength={0} />
            <Image systemName="arrow.trianglehead.2.clockwise.rotate.90" font={8.5 * scale} foregroundStyle="secondaryLabel" />
            <Text font={10 * scale} fontWeight="medium" foregroundStyle="secondaryLabel">{shortTime(now)}</Text>
          </HStack>
          {visibleApps.map((item, index) => {
            const value = countdown(item.expiresAt, now, settings.totalDays)
            return <VStack alignment="leading" spacing={7 * scale}
              frame={{ width: rightWidth, height: 30 * scale }}
              position={{ x: rightWidth / 2, y: listTop + rowHeight * (index + 0.5) }}>
              <HStack spacing={4 * scale} frame={{ width: rightWidth, height: 16 * scale }}>
                <Circle fill={pointColor(value.progress)} frame={{ width: 5 * scale, height: 5 * scale }} />
                <Text font={12 * scale} fontWeight="semibold" foregroundStyle="label" lineLimit={1}
                  frame={{ width: Math.max(0, rightWidth - 62 * scale), alignment: "leading" }}>{item.name}</Text>
                <Spacer minLength={0} />
                <Text font={10 * scale} fontWeight="medium" foregroundStyle={value.expired ? "systemRed" : "secondaryLabel"}
                  frame={{ width: 42 * scale, alignment: "trailing" }} lineLimit={1}>{value.expired ? "已到期" : `${value.text} 天`}</Text>
              </HStack>
              <ProgressBlocks expiresAt={item.expiresAt} now={now} totalDays={settings.totalDays} width={rightWidth} />
            </VStack>
          })}
          {!visibleApps.length ? <Text font={12 * scale} foregroundStyle="secondaryLabel" lineLimit={2}
            frame={{ width: rightWidth }}>授权数据后显示应用有效期</Text> : null}
        </ZStack> : null}
      </HStack>
    }}
  </GeometryReader>
}
