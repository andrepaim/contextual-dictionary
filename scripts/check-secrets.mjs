// Fails when a tracked file contains something that looks like a credential.
//
//   node scripts/check-secrets.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const PATTERNS = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['API secret key', /\bsk-[A-Za-z0-9_-]{32,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
]
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const found = []
for (const file of files) {
  if (file === 'package-lock.json') continue
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { continue }
  if (text.includes('\0')) continue
  text.split('\n').forEach((line, index) => {
    for (const [name, pattern] of PATTERNS) if (pattern.test(line)) found.push(`${file}:${index + 1}: ${name}`)
  })
}
if (found.length) {
  console.error(`Possible secrets:\n${found.join('\n')}`)
  process.exit(1)
}
console.log(`No secrets found in ${files.length} tracked files.`)
