// End-to-end variant of the model worker (src/model/worker.entry.ts),
// swapped in by `node scripts/build.mjs --e2e`. It speaks the same protocol
// through the real worker handler, but its session is a deterministic stand-in:
//
// - the format comes from the installed model_metadata.json, calibration.json
//   and tokenizer_config.json, as the real session reads it;
// - a meaning scores one point for each word of four letters or more that it
//   shares with the passage, so "move the cursor on screen" picks the
//   pointing device; "none of the above" scores below every meaning;
// - a passage containing the word "slowly" is answered after SLOW_MS, past the
//   default budget.
import { CodedError, type ModelLoad, type SenseFormat, type WorkerRequest, type WorkerResponse } from '../../../src/shared/contracts'
import type { SenseSession } from '../../../src/model/session'
import { createWorkerHandler } from '../../../src/model/worker-handler'

export const E2E_MARKER = '__CD_E2E_VARIANT__'
export const SLOW_MS = 1500

function readFormat(load: ModelLoad): SenseFormat {
  try {
    const metadata = JSON.parse(load.metadata), calibration = JSON.parse(load.calibration), config = JSON.parse(load.tokenizerConfig)
    return {
      letters: metadata.letters, nota_index: metadata.nota_index, none_text: metadata.none_text, separator: metadata.separator,
      mask_token: config.mask_token, max_length: metadata.max_length, temperature: calibration.temperature ?? 1,
    }
  } catch {
    throw new CodedError('MODEL_MISMATCH')
  }
}

const words = (text: string) => new Set((text.toLowerCase().match(/\p{L}{4,}/gu) ?? []))

function fakeSession(load: ModelLoad): SenseSession {
  const format = readFormat(load)
  if (new TextDecoder().decode(new Uint8Array(load.model, 0, 9)) !== 'FAKE-ONNX') throw new CodedError('SESSION_FAILED')
  return {
    format,
    async logits(prompt) {
      const lines = prompt.split('\n')
      const passage = lines[0] ?? ''
      if (/\bslowly\b/i.test(passage)) await new Promise(resolve => setTimeout(resolve, SLOW_MS))
      const context = words(passage.replace(/\*[^*]*\*/u, ' '))
      const logits = new Float32Array(128).fill(-20)
      lines.slice(1, -2).forEach((line, index) => {
        const definition = line.slice(line.indexOf('. ') + 2)
        logits[index] = [...words(definition)].filter(word => context.has(word)).length * 3
      })
      logits[format.nota_index] = -10
      return logits
    },
    async release() {},
  }
}

interface WorkerScope {
  postMessage(message: WorkerResponse, transfer: Transferable[]): void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  close(): void
}
const scope = self as unknown as WorkerScope
Object.assign(scope, { [E2E_MARKER]: true })

const handler = createWorkerHandler({
  post: (message, transfer = []) => scope.postMessage(message, transfer),
  exit: () => scope.close(),
  open: async load => fakeSession(load),
})
scope.onmessage = event => handler.handle(event.data)
