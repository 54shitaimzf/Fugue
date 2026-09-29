// fugue 的配置组（`config` · `policy`）——U4c 自 `cli/fugue.ts` 抽出，内容逐字未动
// （出处：架构 § 15.3.a 工作区配置 · § 8.8 策略值）。**两处都不建视图、不读日志**：
// 配置是工作区的输入，不是它的状态；策略值的输入是配置与探针。
import { PolicyError, probeLayers, resolvePolicy } from '../../boundary/policy.ts'
import { BindingError, readBinding } from '../../boundary/binding.ts'
import {
  ConfigError,
  configFileOf,
  getConfig,
  parseConfigValue,
  readConfig,
  setConfig,
  writeConfig,
} from '../../config.ts'
import { agentFor } from '../../identity.ts'
import { createRoots } from '../../roots/roots.ts'
import { resolve } from 'node:path'
import { emitJson, emitLine, fail, modeOf, usageFail, writerOf } from '../shared.ts'

export async function config(root: string, args: string[], json: boolean): Promise<number> {
  const verb = args[0]
  try {
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
      const key = args[1]
      const raw = args[2]
      if (key === undefined || raw === undefined) return usageFail('config set 需要 <key> <value>', json)
      const doc = await readConfig(root)
      const old = getConfig(doc, key)
      const value = parseConfigValue(raw)
      setConfig(doc, key, value)
      await writeConfig(root, doc)
      const out: Record<string, unknown> = { key, value, path: configFileOf(root) }
      // **老值只在原本有这条键时出现**：凭空多一个 `old: null` 会与"存了个 null"混起来。
      if (old !== undefined) out.old = old
      if (json) emitJson(out)
      else {
        emitLine(`${key}	${old === undefined ? '(没有)' : JSON.stringify(old)}	→	${JSON.stringify(value)}`)
      }
      return 0
    }
    return usageFail(`config 需要 show|get|set，收到：${verb ?? '(空)'}`, json)
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
