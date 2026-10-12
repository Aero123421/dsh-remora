/*! Bundles qrcode-generator 1.5.2 — Copyright (c) 2009 Kazuhiko Arase — MIT License. "QR Code" is a registered trademark of DENSO WAVE INCORPORATED. */
import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

/** QR code of `value` as an SVG path (one path, no external requests). */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const code = qrcode(0, 'M')
    code.addData(value)
    code.make()
    const count = code.getModuleCount()
    let d = ''
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) if (code.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`
    }
    return { size: count, path: d }
  }, [value])
  return <div className="rmr-qr">
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <path d={path} fill="#000" />
    </svg>
  </div>
}
