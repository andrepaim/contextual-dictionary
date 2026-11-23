// The Web Worker that runs the word-sense model. Wiring only: the protocol is
// in worker-handler.ts and the session in session.ts; see docs/plan.md
// section 5.3.
//
// `onnxruntime-web/wasm` is the WebAssembly-only build. The build resolves it
// with the `onnxruntime-web-use-extern-wasm` condition, so the runtime's
// loader (`ort-wasm-simd-threaded.mjs`) and binary are read from `wasmBase`
// inside the extension, never from a CDN, and its thread workers start from
// that loader rather than from this file.
import type { WorkerRequest, WorkerResponse } from '../shared/contracts'
import { createSenseSession, type SenseRuntime } from './session'
import { createWorkerHandler } from './worker-handler'

interface WorkerScope {
  postMessage(message: WorkerResponse, transfer: Transferable[]): void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  close(): void
}
const scope = self as unknown as WorkerScope

const runtime = async (): Promise<SenseRuntime> => {
  const [ort, tokenizers] = await Promise.all([import('onnxruntime-web/wasm'), import('@huggingface/tokenizers')])
  return { ort, tokenizers }
}

const handler = createWorkerHandler({
  post: (message, transfer = []) => scope.postMessage(message, transfer),
  exit: () => scope.close(),
  open: load => createSenseSession(load, runtime),
})
scope.onmessage = event => handler.handle(event.data)
