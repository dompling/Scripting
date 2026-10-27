import { Button, Circle, GeometryReader, HStack, Image, PathShape, Spacer, Text, VStack, ZStack } from "scripting"
import { countdown, shortDate, shortTime } from "./model"
import { Settings, WidgetState } from "./runtime"
import { backgroundGradient, DEFAULT_BACKGROUNDS } from "./appearance"

function hexToRgb(hex: string): [number, number, number] {
  const val = hex.replace("#", "")
  return [parseInt(val.slice(0, 2), 16), parseInt(val.slice(2, 4), 16), parseInt(val.slice(4, 6), 16)]
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

const GRADIENT_STOPS: [number, number, number][] = [
  hexToRgb("#B82020"),
  hexToRgb("#F08A1D"),
  hexToRgb("#F5D627"),
  hexToRgb("#F5D627"),
  hexToRgb("#89C853"),
  hexToRgb("#26A67A"),
]

function pointColor(progress: number): any {
  const t = Math.max(0, Math.min(1, progress))
  const maxIdx = GRADIENT_STOPS.length - 1
  const pos = t * maxIdx
  const idx = Math.floor(pos)
  if (idx >= maxIdx) return rgbToHex(GRADIENT_STOPS[maxIdx][0], GRADIENT_STOPS[maxIdx][1], GRADIENT_STOPS[maxIdx][2])
  const ratio = pos - idx
  const [r1, g1, b1] = GRADIENT_STOPS[idx]
  const [r2, g2, b2] = GRADIENT_STOPS[idx + 1]
  return rgbToHex(r1 + (r2 - r1) * ratio, g1 + (g2 - g1) * ratio, b1 + (b2 - b1) * ratio)
}

function colorWithAlpha(hex: string, alpha: number): any {
  const [r, g, b] = hexToRgb(hex)
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
    <HStack spacing={p(4)} alignment="center" frame={{ width: p(140), height: p(24) }} position={{ x: p(80), y: p(20) }}>
      <Logo size={p(14)} />
      <Text font={p(12)} fontWeight="bold" foregroundStyle="label" lineLimit={1}>SideStore</Text>
      <Spacer minLength={0} />
      {showRefreshTime ? <Button shortcutIndex={0}
        buttonStyle="plain"
        frame={{ width: p(24), height: p(24) }}
        contentShape={{ type: "capsule", style: "circular" }}>
        <ZStack frame={{ width: p(20), height: p(20) }}
          background={{ style: colorWithAlpha(markerColor, 0.14), shape: "capsule" }}>
          <Image systemName="hand.tap.fill" font={p(12)} foregroundStyle="secondaryLabel" />
        </ZStack>
      </Button> : null}
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
  const progressColor = app ? pointColor(countdown(app.expiresAt, now, settings.totalDays).progress) : undefined
  const lightTint = settings.tintWithProgress && progressColor ? progressColor : settings.lightBackground
  const darkTint = settings.tintWithProgress && progressColor ? progressColor : settings.darkBackground

  return <GeometryReader
    widgetBackground={{
      light: backgroundGradient(lightTint, DEFAULT_BACKGROUNDS.light),
      dark: backgroundGradient(darkTint, DEFAULT_BACKGROUNDS.dark),
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
          <HStack spacing={3} alignment="center" frame={{ width: rightWidth, height: 24 * scale }}
            position={{ x: rightWidth / 2, y: 20 * scale }}>
            <Spacer minLength={0} />
            <Button shortcutIndex={0}
              buttonStyle="plain"
              frame={{ width: 24 * scale, height: 24 * scale }}
              contentShape={{ type: "capsule", style: "circular" }}>
              <ZStack frame={{ width: 20 * scale, height: 20 * scale }}
                background={{ style: colorWithAlpha(pointColor(countdown(apps[0]?.expiresAt, now, settings.totalDays).progress), 0.14), shape: "capsule" }}>
                <Image systemName="hand.tap.fill" font={12 * scale} foregroundStyle="secondaryLabel" />
              </ZStack>
            </Button>
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
