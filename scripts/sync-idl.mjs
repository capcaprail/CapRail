#!/usr/bin/env node
// Переносить IDL зі збірки Anchor у git.
//
// `target/` ігнорується, а `apps/web` і `apps/api` збираються там, де ані WSL,
// ані `anchor build` не існує. Без вендорованої копії клієнт існує тільки на
// машині, де щойно зібрали програму.
//
// **Тип і значення беруться з одного тексту.** `target/types/caprail.ts` — це
// `export type Caprail = { … }`, і його тіло вже є валідним JSON, тож той самий
// блок стає і типом, і значенням. Копія, зроблена окремо, розходиться з цим
// типом: генератор типів лишає `"path": "args.company_id"`, а рантайм
// `Program` перетворює його на `args.companyId`. На рантайм це не впливає, але
// два джерела одного файлу дали б розбіжність на рівному місці.
//
//   node scripts/sync-idl.mjs          — перезаписати вендоровані копії
//   node scripts/sync-idl.mjs --check  — впасти, якщо копія розійшлася зі збіркою
//
// `--check` мовчки пропускає перевірку, коли `target/` немає: гейт має бути
// зеленим і на машині без WSL, і в деплої, де ончейн-збірки не буває взагалі.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Дві програми — два IDL. Хук клієнт не викликає напряму, але його адреса й
// розкладка `execute` потрібні білдерам (`transferWithHook`) і демо.
const PROGRAMS = [
  { name: 'caprail', type: 'Caprail', out: 'caprail.ts' },
  { name: 'caprail_hook', type: 'CaprailHook', out: 'caprailHook.ts' },
]

const HEADER = `// ЗГЕНЕРОВАНО \`pnpm idl:sync\` з target/types. Руками не редагувати.
//
// Тип — те, що згенерував \`anchor build\`; значення — той самий текст під
// анотацією цього типу. Анотація не декоративна: вона і є перевіркою, що
// вендорована копія не розійшлася з програмою — зайве поле чи інше ім'я не
// скомпілюється.
//
// Імена всередині лишаються такими, як їх пише Anchor: \`Program\` проганяє
// переданий IDL через власну конверсію в camelCase, тож форма запису тут на
// рантайм не впливає.
`

const checkOnly = process.argv.includes('--check')

function fail(message) {
  process.stderr.write(`sync-idl: ${message}\n`)
  process.exit(1)
}

function paths({ name, type, out }) {
  return {
    json: join(root, 'target', 'idl', `${name}.json`),
    types: join(root, 'target', 'types', `${name}.ts`),
    out: join(root, 'packages', 'chain', 'src', 'idl', out),
    prefix: `export type ${type} = `,
    type,
  }
}

function generate(program) {
  const { json, types, prefix, type } = paths(program)
  const declaration = readFileSync(types, 'utf8').replace(/\r\n/g, '\n')
  const opening = declaration.indexOf(prefix)
  if (opening === -1) fail(`${relative(root, types)} не оголошує тип ${type}`)

  const body = declaration
    .slice(opening + prefix.length)
    .trim()
    .replace(/;$/, '')

  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    fail(`тіло типу не є JSON — Anchor змінив формат генерації: ${error.message}`)
  }

  // Два файли з однієї збірки. Розбіжність означає, що `target/` зібраний
  // наполовину, і вендорувати з нього не можна нічого.
  const raw = JSON.parse(readFileSync(json, 'utf8'))
  if (parsed.address !== raw.address || parsed.instructions.length !== raw.instructions.length) {
    fail(`target/idl і target/types для ${type} розійшлися — перезібрати програму`)
  }

  return `${HEADER}\n${prefix}${body}\n\nexport const IDL: ${type} = ${body}\n`
}

for (const program of PROGRAMS) {
  const { json, types, out } = paths(program)
  if (!existsSync(json) || !existsSync(types)) {
    if (checkOnly) {
      process.stdout.write('sync-idl: target/ немає — звіряти нема з чим, пропускаю\n')
      process.exit(0)
    }
    fail(`немає ${relative(root, json)} — спершу зібрати IDL (scripts/wsl-build.sh idl)`)
  }

  const generated = generate(program)

  if (checkOnly) {
    if (!existsSync(out)) fail(`немає ${relative(root, out)} — запустити \`pnpm idl:sync\``)
    const current = readFileSync(out, 'utf8').replace(/\r\n/g, '\n')
    if (current !== generated) {
      fail(`${relative(root, out)} розійшовся зі збіркою — запустити \`pnpm idl:sync\``)
    }
    continue
  }

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, generated, 'utf8')
  process.stdout.write(`sync-idl: записано ${relative(root, out)}\n`)
}

if (checkOnly) {
  process.stdout.write('sync-idl: вендоровані IDL збігаються зі збіркою\n')
}
