import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, AlertTriangle, ArrowRight, QrCode, X } from 'lucide-react'
import type { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser'

export default function ScannerPage() {
  const [traceId, setTraceId] = useState('')
  const [cameraState, setCameraState] = useState<'idle' | 'starting' | 'scanning'>('idle')
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([])
  const [activeCameraId, setActiveCameraId] = useState('')
  const [scanError, setScanError] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const readerRef = useRef<BrowserMultiFormatReader | null>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  const navigate = useNavigate()

  useEffect(() => () => controlsRef.current?.stop(), [])

  const stopCamera = () => {
    controlsRef.current?.stop()
    controlsRef.current = null
    const stream = videoRef.current?.srcObject
    if (stream instanceof MediaStream) stream.getTracks().forEach((track) => track.stop())
    setCameraState('idle')
  }

  const handleScan = (rawValue: string) => {
    const value = rawValue.trim()
    let candidate = value
    if (!/^TT-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
      try {
        const url = new URL(value)
        const match = url.origin === window.location.origin ? url.pathname.match(/^\/verify\/([^/]+)\/?$/) : null
        candidate = match ? decodeURIComponent(match[1]) : ''
      } catch {
        candidate = ''
      }
    }
    stopCamera()
    if (!/^TT-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(candidate)) {
      setScanError('This code is not a TrustTrace identity or same-site verification link.')
      return
    }
    navigate(`/verify/${encodeURIComponent(candidate)}`)
  }

  const startCamera = async (deviceId = activeCameraId) => {
    if (!videoRef.current) return
    setScanError('')
    setCameraState('starting')
    try {
      const { BrowserMultiFormatReader } = await import('@zxing/browser')
      readerRef.current ??= new BrowserMultiFormatReader()
      const reader = readerRef.current
      const callback = (result: { getText(): string } | undefined) => {
        if (result) handleScan(result.getText())
      }
      const controls = deviceId
        ? await reader.decodeFromVideoDevice(deviceId, videoRef.current, callback)
        : await reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } } }, videoRef.current, callback)
      controlsRef.current = controls
      setCameraState('scanning')
      const devices = await BrowserMultiFormatReader.listVideoInputDevices()
      setCameraDevices(devices)
      if (!deviceId && devices[devices.length - 1]) setActiveCameraId(devices[devices.length - 1].deviceId)
    } catch (error) {
      setCameraState('idle')
      const name = error instanceof DOMException ? error.name : ''
      setScanError(name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access in your browser settings and try again.' : name === 'NotFoundError' ? 'No camera was found on this device.' : 'The camera could not start. Check browser permissions and try again.')
    }
  }

  const switchCamera = async () => {
    if (cameraDevices.length < 2) return
    const currentIndex = cameraDevices.findIndex((device) => device.deviceId === activeCameraId)
    const next = cameraDevices[(currentIndex + 1) % cameraDevices.length]
    stopCamera()
    setActiveCameraId(next.deviceId)
    await startCamera(next.deviceId)
  }

  return <><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />IDENTITY LOOKUP</div><h1>Scan a product</h1><p>Scan a QR code or barcode, or enter a Trace ID manually.</p></div></section><div className="scan-layout"><div className="surface scanner-panel"><div className={`scanner-frame ${cameraState === 'scanning' ? 'camera-active' : ''}`}><video ref={videoRef} className="camera-video" autoPlay muted playsInline /><span className="scan-corner top-left" /><span className="scan-corner top-right" /><span className="scan-corner bottom-left" /><span className="scan-corner bottom-right" />{cameraState !== 'scanning' && <div className="camera-placeholder"><QrCode size={44} strokeWidth={1.2} /><span>{cameraState === 'starting' ? 'Connecting to camera...' : 'Camera scanner'}</span></div>}</div>{scanError && <div className="scan-error" role="alert"><AlertTriangle size={15} />{scanError}</div>}<div className="scanner-controls"><button className="button button-primary" type="button" onClick={() => cameraState === 'scanning' ? stopCamera() : void startCamera()}>{cameraState === 'scanning' ? <><X size={16} />Stop camera</> : <><QrCode size={16} />{cameraState === 'starting' ? 'Starting...' : 'Start camera'}</>}</button><button className="button button-secondary" type="button" onClick={() => void switchCamera()} disabled={cameraDevices.length < 2}><Activity size={15} />Switch camera</button></div><p className="scanner-hint">QR codes and common 1D barcodes are supported. Camera access requires permission.</p></div><div className="surface manual-scan"><span className="section-kicker">MANUAL LOOKUP</span><h2>Enter Trace ID</h2><p>Use the opaque ID printed on the product or package label.</p><form onSubmit={(event) => { event.preventDefault(); if (/^TT-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(traceId.trim())) navigate(`/verify/${encodeURIComponent(traceId.trim())}`); else setScanError('Enter a complete TrustTrace ID in the TT-UUID format.') }}><label className="field"><span>Trace ID</span><input value={traceId} onChange={(event) => setTraceId(event.target.value)} placeholder="TT-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" /></label><button className="button button-primary" type="submit">Verify identity <ArrowRight size={16} /></button></form></div></div></>
}
