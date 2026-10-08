const path = require('path')
const { buildFindstrGuardPlan, executeFindstrGuardCommand, buildSearchCaveat } = require('../electron/modules/tool-handlers/command')

const root = path.resolve(__dirname, '..')

async function main() {
  // 1. 用户翻车原命令：应解析出 cd 前缀、字面模式、裸目录、find 计数器
  const userCmd = `cd /d "${root}" && findstr /S /N /C:"require('./chat/step-assembly')" "${root}\\electron\\modules" 2>&1 | find /v "" /c`
  const plan = buildFindstrGuardPlan(userCmd, root)
  if (!plan) throw new Error('用户原命令应被守卫接管')
  if (!plan.counterMode) throw new Error('应识别 find /c 计数器')
  if (!plan.rgArgs.includes('-F')) throw new Error('/C 字面串应映射 -F: ' + plan.rgArgs.join(' '))
  if (!plan.rgArgs.includes("require('./chat/step-assembly')")) throw new Error('应保留原始模式')
  if (!plan.rgArgs.some(a => a.endsWith('electron\\modules'))) throw new Error('裸目录应作为 rg 搜索路径: ' + plan.rgArgs.join(' '))
  if (!plan.notes.some(n => n.includes('裸目录'))) throw new Error('应记录裸目录修复说明')

  // 2. 真实执行：字符串存在于 ai-chat.js，应数到 1，退出码必须为 0
  const real = await executeFindstrGuardCommand(userCmd, root)
  if (!real || !real.findstr_rewritten) throw new Error('应真实改写执行')
  if (real.exit_code !== 0 || real.stdout.trim() !== '1') {
    throw new Error(`应数到 1 且退出码 0，实际 stdout=${JSON.stringify(real.stdout)} exit=${real.exit_code}`)
  }
  if (!real.counter_note) throw new Error('计数模式应带语义说明')

  // 3. 真零命中：退出码也必须为 0（find /c 的 1 语义被守卫消掉）
  const zeroCmd = `findstr /S /N /C:"zzz-no-such-string-zzz-9f8e7d" "${root}\\electron\\modules\\*.js" | find /v "" /c`
  const zero = await executeFindstrGuardCommand(zeroCmd, root)
  if (!zero || zero.exit_code !== 0 || zero.stdout.trim() !== '0' || !zero.noMatches) {
    throw new Error(`真零命中应 stdout=0 且 exit=0，实际 ${JSON.stringify({ stdout: zero?.stdout, exit: zero?.exit_code })}`)
  }

  // 4. 通配符文件规格：dir\*.js → 路径 + -g
  const globPlan = buildFindstrGuardPlan('findstr /S /I "TODO" electron\\modules\\*.js', root)
  if (!globPlan) throw new Error('通配符规格应可翻译')
  const gIndex = globPlan.rgArgs.indexOf('-g')
  if (gIndex < 0 || globPlan.rgArgs[gIndex + 1] !== '*.js') throw new Error('应生成 -g *.js: ' + globPlan.rgArgs.join(' '))
  if (!globPlan.rgArgs.includes('-i')) throw new Error('/I 应映射 -i')

  // 5. 引号串空格 = OR 语义
  const orPlan = buildFindstrGuardPlan('findstr /S "foo bar" electron', root)
  if (!orPlan || !orPlan.rgArgs.includes('foo') || !orPlan.rgArgs.includes('bar')) {
    throw new Error('引号空格串应拆成 OR 模式')
  }

  // 6. 不重写的情形：findstr 正则方言、/G: 文件、普通管道、非 findstr
  if (buildFindstrGuardPlan('findstr /S "foo.*bar" electron', root)) {
    throw new Error('默认正则含元字符不应重写')
  }
  if (buildFindstrGuardPlan('findstr /G:terms.txt *.js', root)) {
    throw new Error('/G: 不应重写')
  }
  if (buildFindstrGuardPlan('findstr /N TODO a.js | more', root)) {
    throw new Error('非 find 计数管道不应重写')
  }
  if (buildFindstrGuardPlan('rg -n TODO electron', root)) {
    throw new Error('rg 命令不归 findstr 守卫')
  }
  if (buildFindstrGuardPlan('dir /b', root)) throw new Error('dir 不应被接管')

  // 7. caveat：裸目录 + find /c 双语义
  const caveat = buildSearchCaveat(userCmd, { code: 1, error: 'command exited with code 1' })
  if (!caveat || caveat.kind !== 'search_caveat') throw new Error('应生成 search_caveat')
  const reasons = caveat.caveats.map(c => c.reason)
  if (!reasons.includes('findstr_bare_directory')) throw new Error('应指出裸目录问题: ' + JSON.stringify(caveat))
  if (!reasons.includes('find_count_exit_code')) throw new Error('应指出 find /c 退出码语义')
  if (buildSearchCaveat('npm run build', { code: 1 })) throw new Error('非搜索命令不应生成 caveat')

  console.log('findstr-guard: plan/rewrite/counter/caveat OK')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
