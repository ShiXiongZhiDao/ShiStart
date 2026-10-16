/**
 * 同步空间的身份归属。
 *
 * 一个远端目录里的所有设备共用**同一份**数据，所以它们必须认同一个 spaceId。
 * 而 spaceId 是每台设备本地生成的 —— 第二台设备第一次连上来时，
 * 它手里那个 id 跟远端当然不一样。
 *
 * 这不是冲突，是"它还不知道这个空间叫什么"。所以这里的规则只有一条：
 * **远端说了算**。谁先建的空间，空间就叫什么名字。
 *
 * 反过来把这种情况报成错误，会让两台设备永远连不到一起：
 * 用户填的是同一个地址、同一个账号，他没有任何线索能想到问题出在一个 uuid 上。
 */

export type SpaceIdentityDecision =
  /** 远端还没有 space.json ⇒ 用本地这个 id 建空间。 */
  | { kind: 'create'; spaceId: string }
  /** 远端已有空间 ⇒ 采纳它，本地那个自生成的 id 丢掉。 */
  | { kind: 'adopt'; spaceId: string }
  /** 两边一致，什么都不用做。 */
  | { kind: 'match'; spaceId: string };

/** 远端 space.json 里读出来的 id。空串 / 缺失 / 不是字符串都算"远端没有声明"。 */
export function remoteSpaceIdOf(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const value = (raw as { spaceId?: unknown }).spaceId;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 决定这次要用哪个 spaceId。
 *
 * @param localSpaceId  本地配置里的 id。可能是空的（还没建过）或是自己生成的。
 * @param remoteSpaceId 远端 space.json 里的 id，空串表示远端还没有。
 */
export function decideSpaceIdentity(localSpaceId: string, remoteSpaceId: string): SpaceIdentityDecision {
  const local = localSpaceId.trim();

  // 远端没有声明：本地有就用本地的，本地也没有就由调用方生成后走 create。
  if (remoteSpaceId === '') {
    return { kind: local === '' ? 'create' : 'create', spaceId: local };
  }
  // 远端说了算。本地是空的、或者跟远端不一样，都采纳远端。
  if (local !== remoteSpaceId) return { kind: 'adopt', spaceId: remoteSpaceId };
  return { kind: 'match', spaceId: local };
}

/**
 * 采纳远端空间身份之后，本地那些"属于旧空间"的东西要不要清掉。
 *
 * 答案是**不清**。映射（nativeId → syncId）和基线（上一次合并的结果）
 * 都是按 syncId 存的，跟 spaceId 无关 —— 同一个书签在两台设备上是同一个 syncId，
 * 正是这一点让跨设备合并成立。
 *
 * 清掉它们的后果很严重：映射没了，本地每个书签都会被当成新书签重新上传一遍，
 * 整棵树在远端复制一份，然后合并的时候两边"各自新增"同一个标题的书签。
 * 而这个动作是静默的，用户只看到书签变多了。
 */
export function shouldResetLocalStateOnAdopt(): false {
  return false;
}
