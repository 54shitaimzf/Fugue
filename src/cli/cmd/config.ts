// fugue 的配置组（`config` · `policy`）——U4c 自 `cli/fugue.ts` 抽出，内容逐字未动
// （出处：架构 § 15.3.a 工作区配置 · § 8.8 策略值）。**两处都不建视图、不读日志**：
// 配置是工作区的输入，不是它的状态；策略值的输入是配置与探针。
import { PolicyError, probeLayers, resolvePolicy } from '../../boundary/policy.ts'
import { BindingError, readBinding } from '../../boundary/binding.ts'
import {
  appendHistory,
  configHistoryOf,
  ConfigError,
  configFileOf,
  configuredKeyPaths,
  configKeyPathsJson,
  defaultSystemDir,
  getConfig,
  formatConfigKeyPath,
  keySegments,
  parseConfigValue,
  readConfig,
  readSystemConfig,
  readWorkspaceConfig,
  setConfig,
  systemConfigFileOf,
  systemConfigHistoryOf,
  TOP_LEVEL_KEYS,
  writeConfig,
  writeSystemConfig,
} from '../../config.ts'
import { agentFor } from '../../identity.ts'
import { keymapOf } from '../../ui/keymap.ts'
import { createRoots } from '../../roots/roots.ts'
import { resolve } from 'node:path'
import { emitJson, emitLine, fail, modeOf, usageFail, writerOf } from '../shared.ts'

export async function config(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const verb = args[0]
  try {
    if (verb === 'ls') {
      if (args.length !== 1) return usageFail('config ls 不接受位置参数；列系统级与工作区级合并后在场的键', json)
      const paths = configuredKeyPaths(await readConfig(root))
      if (json) emitLine(configKeyPathsJson(paths))
      else for (const path of paths) emitLine(formatConfigKeyPath(path))
      return 0
    }
    if (verb === 'show') {
      const doc = await readConfig(root)
      emitLine(json ? JSON.stringify(doc) : JSON.stringify(doc, null, 2))
      return 0
    }
    if (verb === 'get') {
      const key = args[1]
      if (key === undefined) return usageFail('config get 需要 <key>', json)
      const value = getConfig(await readConfig(root), key)
      if (value === undefined) return fail(`config get：没有这条键 —— ${key}`, json)
      // 人这一面：字符串吐原样（好接管道），别的吐 JSON。`--json` 那一面一律是 JSON。
      if (json) emitJson(value)
      else emitLine(typeof value === 'string' ? value : JSON.stringify(value))
      return 0
    }
    if (verb === 'set') {
      // `--system` 写系统那一级（`~/.fugue`）；不带它照旧写工作区。开关由分发处收进 flags，
      // 到这里的 args 只有位置参数。写永远落单级——合并只在读。
      const system = flags.has('system')
      const key = args[1]
      const raw = args[2]
      if (key === undefined || raw === undefined) {
        return usageFail('config set 需要 <key> <value>（--system 写系统级）', json)
      }
      // 顶层键域把关在**写**这一面：读那面也会核（P2a），但写时拦住才不会把文件写成
      // 之后每一次读都拒的样子——那是把配置砖掉，不是拒绝并指路。
      const top = keySegments(key)[0]
      if (!TOP_LEVEL_KEYS.includes(top)) {
        return fail(
          `config set：顶层键只认 ${TOP_LEVEL_KEYS.join(' · ')} —— ${top} 不在其中；` +
            `要加新的顶层键，先把键域定下来（架构 § 15.3.a）`,
          json,
        )
      }
      const value = parseConfigValue(raw)
      // `ui.keys` 的键值在**写**这一面就过一遍 `keymapOf`（清障批 ⑧ 接线：它从无消费者升格为
      // 合法校验）。手改文件配错的那一档由 TUI 读那面逐格照缺省走并印出为什么；写时拦住并说
      // 为什么，人才知道键串该怎么写。形状读那面也核，这里核语义。
      const segs = keySegments(key)
      if (segs[0] === 'ui' && segs[1] === 'keys') {
        const over: Record<string, string> = {}
        if (segs.length === 2) {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return fail('config set：ui.keys 要是一个「动作 → 键串」的对象', json)
          }
          for (const [a, k] of Object.entries(value)) {
            if (typeof k !== 'string') {
              return fail(`config set：ui.keys.${a} 的值要是键串 —— ${JSON.stringify(k)}`, json)
            }
            over[a] = k
          }
        } else if (segs.length === 3) {
          if (typeof value !== 'string') {
            return fail(`config set：ui.keys.${segs[2]} 的值要是键串 —— ${JSON.stringify(value)}`, json)
          }
          over[segs[2]] = value
        } else {
          return fail(`config set：ui.keys 下面没有更深一层 —— ${key}`, json)
        }
        const bad = keymapOf(over).problems
        if (bad.length > 0) {
          return fail(
            `config set：这组键位配不了 —— ${bad.map((p) => `${p.action}: ${p.why}`).join('；')}`,
            json,
          )
        }
      }
      const out: Record<string, unknown> = { key, value }
      if (system) {
        const dir = defaultSystemDir()
        const doc = await readSystemConfig(dir)
        const old = getConfig(doc, key)
        setConfig(doc, key, value)
        await writeSystemConfig(dir, doc)
        await appendHistory(systemConfigHistoryOf(dir), { key, old, new: value })
        out.path = systemConfigFileOf(dir)
        if (old !== undefined) out.old = old
      } else {
        const doc = await readWorkspaceConfig(root)
        const old = getConfig(doc, key)
        setConfig(doc, key, value)
        await writeConfig(root, doc)
        await appendHistory(configHistoryOf(root), { key, old, new: value })
        out.path = configFileOf(root)
        if (old !== undefined) out.old = old
      }
      if (json) emitJson(out)
      else {
        const old = 'old' in out ? JSON.stringify(out.old) : '(没有)'
        emitLine(`${key}	${old}	→	${JSON.stringify(value)}`)
      }
      return 0
    }
    return usageFail(`config 需要 show|get|set|ls，收到：${verb ?? '(空)'}`, json)
  } catch (err) {
    if (err instanceof ConfigError) return fail(err.message, json)
    throw err
  }
}

/**
 * `fugue policy [<action>]`——把这一趟的策略值印出来（架构 § 8.8 · § 9.6 的边界那一行）。
 *
 * **两处读同一份**：这里印的与 `fugue run` 写进 `run/confined` 的，是同一个 `resolvePolicy()`
 * 的返回值——不是两处各算一遍再对答案。所以它不需要视图、不需要日志：策略值的输入是配置与
 * 探针，不是工作区的状态（与 `config` 同一条道理）。
 *
 * 给了 `<action>` 就报**那个动作那一趟**的值：动作是唯一能点名要网的地方（`net` 那一栏）。
 */
export async function policyCmd(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const mode = modeOf(flags)
  if (mode === null) {
    return usageFail(`--mode 取 read-only 或 workspace-write：${JSON.stringify(flags.get('mode'))}`, json)
  }
  const abs = resolve(root)
  const agent = agentFor(writerOf(flags))
  const name = args[0]
  try {
    const doc = await readConfig(abs)
    const binding = name === undefined || name === '' ? undefined : readBinding(doc, name)
    const roots = createRoots(abs)
    const probed = probeLayers(roots)
    const policy = resolvePolicy({ roots, agent, doc, mode, binding, probed })
    if (json) {
      emitJson({ agent, action: name ?? null, ...policy, note: probed.note })
    } else {
      const layers = policy.layers.length === 0 ? '没有（§ 15.7 的 E4 退化档）' : policy.layers.join(' + ')
      process.stdout.write(
        `档 ${policy.mode} · enforcement ${policy.enforcement} · 在场的层 ${layers}\n` +
          `网络 ${policy.net}${policy.net === 'none' ? '（--unshare-net 把网切掉；回环照旧）' : '（动作点名要的）'}\n` +
          `env 基线 ${policy.env.inherit}（core 定位那几样 · all 宿主整份 · none 空）` +
          `${Object.keys(policy.env.set).length === 0 ? '' : ` · 注入 ${Object.keys(policy.env.set).length} 键`}\n` +
          `可达集 ${policy.reach.roRoots.length} 条只读根 · ${policy.reach.symlinks.length} 条软链 · ` +
          `${policy.reach.devices.length} 处设备与进程 · 树里挖掉 ${policy.reach.mask.join(' · ')}\n` +
          `  只读根 ${policy.reach.roRoots.join(' · ')}\n` +
          `可写落点 ${policy.writableRoots.join(' · ')}\n` +
          `${probed.note}\n`,
      )
    }
    return 0
  } catch (err) {
    if (err instanceof ConfigError || err instanceof BindingError || err instanceof PolicyError) {
      return fail(err.message, json)
    }
    throw err
  }
}
