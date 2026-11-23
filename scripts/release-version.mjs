// Checks that a release tag matches the version being released:
//
//   node scripts/release-version.mjs <tag> [built manifest, default dist/manifest.json]
//
// The tag must be v<version>, where <version> is package.json's version, also
// in package-lock.json and in the built manifest, and a version Chrome
// accepts (one to four numbers). Exits with 1 and the problems otherwise.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function releaseProblems(tag, { packageVersion, lockVersion, manifestVersion }) {
  const problems = []
  const name = String(tag ?? '').replace(/^refs\/tags\//, '')
  if (name !== `v${packageVersion}`) problems.push(`the tag "${name}" must be v<version>, here v${packageVersion} (package.json is ${packageVersion})`)
  if (lockVersion !== packageVersion) problems.push(`package-lock.json says ${lockVersion}, package.json says ${packageVersion}`)
  if (manifestVersion !== packageVersion) problems.push(`the built manifest says ${manifestVersion}, package.json says ${packageVersion}`)
  if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(packageVersion)) problems.push(`${packageVersion} is not a version Chrome accepts (one to four numbers)`)
  return problems
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const read = file => JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'))
  const tag = process.argv[2] ?? ''
  const problems = releaseProblems(tag, {
    packageVersion: read('package.json').version,
    lockVersion: read('package-lock.json').version,
    manifestVersion: read(process.argv[3] ?? 'dist/manifest.json').version,
  })
  if (problems.length) {
    console.error(`Cannot release ${tag || '(no tag)'}:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`${tag} matches the package, lock file and manifest version.`)
}
